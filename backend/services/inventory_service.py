from sqlalchemy.exc import IntegrityError
from sqlalchemy import text, func
from models.inventory import InventoryOption, Purchase, PurchaseItem
from models.order import Product, OrderItem
from services.finance_service import FinanceError
from schemas.customer_schema import normalize_text
import hashlib
import json
import jdatetime
from datetime import timezone
from collections import Counter


DEFAULT_UNITS = (
    "عدد", "بسته", "کیلوگرم", "گرم", "لیتر", "میلی‌لیتر", "متر",
    "سانتی‌متر", "متر مربع", "متر مکعب", "تن", "رول", "جعبه", "کارتن", "ساعت",
)


def initialize_purchase_storage(engine):
    """Add a category to legacy products without changing stock or invoices."""
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(products)")}
        if "category_id" not in columns:
            connection.exec_driver_sql("ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES inventory_options(id) ON DELETE RESTRICT")
        connection.exec_driver_sql("CREATE TABLE IF NOT EXISTS inventory_purchase_migrations (version INTEGER PRIMARY KEY)")
        if not connection.exec_driver_sql("SELECT version FROM inventory_purchase_migrations WHERE version=1").first():
            connection.exec_driver_sql("INSERT OR IGNORE INTO inventory_options (kind, name, active) VALUES ('categories', 'عمومی', 1)")
            connection.exec_driver_sql("UPDATE products SET category_id=(SELECT id FROM inventory_options WHERE kind='categories' AND name='عمومی') WHERE category_id IS NULL")
            connection.exec_driver_sql("INSERT INTO inventory_purchase_migrations (version) VALUES (1)")
        if not connection.exec_driver_sql("SELECT version FROM inventory_purchase_migrations WHERE version=2").first():
            # Backfill receipt rows without replaying historical stock movements.
            connection.exec_driver_sql("""INSERT INTO purchase_items
                (purchase_id, position, product_id, category_id, category_name, product_name, unit, quantity, purchase_price)
                SELECT p.id, 1, p.product_id, p.category_id, p.category_name, p.product_name, p.unit, p.quantity, p.purchase_price
                FROM purchases p WHERE NOT EXISTS (SELECT 1 FROM purchase_items i WHERE i.purchase_id=p.id)""")
            connection.exec_driver_sql("INSERT INTO inventory_purchase_migrations (version) VALUES (2)")


def require_category(db, category_id, *, current=None):
    if category_id is None:
        category_id = current or db.query(InventoryOption.id).filter_by(kind="categories", name="عمومی").scalar()
    category = db.query(InventoryOption).filter_by(id=category_id, kind="categories").first()
    if category is None or (not category.active and category.id != current):
        raise FinanceError("دسته‌بندی فعال کالا را از تنظیمات انتخاب کنید.", 422)
    return category


def next_purchase_number(db):
    # A preview only. Final allocation happens under the purchase write lock.
    return f"PUR-{(db.query(func.max(Purchase.id)).scalar() or 0) + 1:06d}"


def purchase_data(db, item):
    rows = [{**{column.name: getattr(row, column.name) for column in PurchaseItem.__table__.columns},
             "total": row.quantity * row.purchase_price}
            for row in db.query(PurchaseItem).filter_by(purchase_id=item.id).order_by(PurchaseItem.position).all()]
    return {
        **{column.name: getattr(item, column.name) for column in Purchase.__table__.columns if column.name != "request_fingerprint"},
        "jalali_date": jdatetime.date.fromgregorian(date=item.purchase_date).strftime("%Y/%m/%d"),
        "rows": rows,
        "row_count": len(rows),
        "total_quantity": sum(row["quantity"] for row in rows),
        "total": sum(row["total"] for row in rows),
        "created_at": item.created_at.replace(tzinfo=timezone.utc),
    }


def get_purchase(db, purchase_id):
    item = db.get(Purchase, purchase_id)
    if item is None:
        raise FinanceError("خرید موردنظر پیدا نشد.", 404)
    return purchase_data(db, item)


def save_purchase(db, data):
    fingerprint = hashlib.sha256(json.dumps(data.model_dump(mode="json", exclude={"request_id"}), sort_keys=True).encode()).hexdigest()
    fingerprints = {fingerprint}
    if len(data.rows) == 1:
        legacy = {"purchase_date": data.purchase_date.isoformat(), **data.rows[0].model_dump()}
        fingerprints.add(hashlib.sha256(json.dumps(legacy, sort_keys=True).encode()).hexdigest())
    db.rollback()
    try:
        # Serialize stock increments with sales, Settings edits and other purchases.
        db.execute(text("BEGIN IMMEDIATE"))
        previous = db.query(Purchase).filter_by(request_id=str(data.request_id)).first()
        if previous:
            if previous.request_fingerprint not in fingerprints:
                raise FinanceError("این درخواست قبلاً با اطلاعات دیگری ثبت شده است. نتیجه خرید را بررسی کنید.", 409)
            result = purchase_data(db, previous)
            db.commit()
            return result
        records, products, quantities = [], {}, Counter()
        for position, row in enumerate(data.rows, 1):
            category = require_category(db, row.category_id)
            product = db.query(Product).filter_by(id=row.product_id, active=True, deleted_at=None).first()
            if product is None or product.category_id != category.id:
                raise FinanceError(f"کالای فعال ردیف {position} را از دسته‌بندی انتخاب‌شده انتخاب کنید.", 422)
            require_enabled_unit(db, product.unit)
            if product.stock is None:
                raise FinanceError(f"کالای ردیف {position} باید دارای کنترل موجودی باشد.", 422)
            quantities[product.id] += row.quantity
            products[product.id] = product
            records.append({**row.model_dump(), "position": position, "product_name": product.name,
                            "category_name": category.name, "unit": product.unit})
        for product_id, quantity in quantities.items():
            product = products[product_id]
            if product.stock + quantity > 1000000000:
                raise FinanceError("موجودی پس از خرید بیش از حد مجاز است.", 422)
            product.stock += quantity
            product.revision += 1
        # Retain the original receipt columns as the first-row snapshot for older
        # readers; purchase_items owns the complete invoice and its row totals.
        first = {key: value for key, value in records[0].items() if key != "position"}
        item = Purchase(**first, purchase_date=data.purchase_date, request_id=str(data.request_id),
                        request_fingerprint=fingerprint, invoice_number=next_purchase_number(db))
        db.add(item)
        db.flush()
        db.add_all([PurchaseItem(purchase_id=item.id, **record) for record in records])
        db.flush()
        result = purchase_data(db, item)
        db.commit()
        return result
    except IntegrityError:
        db.rollback()
        raise FinanceError("شماره خرید تکراری است. اطلاعات را بروزرسانی کنید.", 409)
    except Exception:
        db.rollback()
        raise


def initialize_unit_storage(engine):
    """Seed the catalog and adopt historical units once, without rewriting records.

    The marker prevents a later restart from undoing deselections or reintroducing
    renamed catalog entries. Existing option selections always take precedence.
    SQLite's VARCHAR declarations don't enforce length, so widening the model to
    the existing reference list's 80 characters needs no table rebuild.
    """
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        connection.exec_driver_sql("CREATE TABLE IF NOT EXISTS inventory_unit_migrations (version INTEGER PRIMARY KEY)")
        if connection.exec_driver_sql("SELECT version FROM inventory_unit_migrations WHERE version=1").first():
            return
        historical = connection.exec_driver_sql("SELECT unit FROM products UNION SELECT unit FROM order_items").scalars().all()
        for name in dict.fromkeys([*DEFAULT_UNITS, *historical]):
            if name and name.strip():
                connection.execute(text("INSERT OR IGNORE INTO inventory_options (kind, name, active) VALUES ('units', :name, 1)"), {"name": name})
        connection.exec_driver_sql("INSERT INTO inventory_unit_migrations (version) VALUES (1)")


def enabled_units(db):
    return db.query(InventoryOption.name).filter_by(kind="units", active=True)


def require_enabled_unit(db, name, *, current=None):
    # Editing an existing record may retain its original disabled/legacy unit;
    # changing it, or creating any new record, requires an enabled catalog entry.
    if current is not None and name == normalize_text(current):
        return current
    if enabled_units(db).filter(InventoryOption.name == name).first():
        return name
    # Free-text units from older installations may use Arabic letters or extra
    # spaces. Match normalized input while retaining the catalog's original name.
    for (configured,) in enabled_units(db).all():
        if name == normalize_text(configured):
            return configured
    raise FinanceError("واحد انتخاب‌شده فعال نیست. واحد را از تنظیمات ← واحد انتخاب یا فعال کنید.", 422)


def option_data(item):
    return {"id": item.id, "name": item.name, "active": item.active}


def list_options(db):
    result = {"categories": [], "units": []}
    for item in db.query(InventoryOption).order_by(InventoryOption.id).all():
        result[item.kind].append(option_data(item))
    return result


def save_option(db, kind, data, option_id=None):
    db.rollback()
    try:
        # Serialize settings changes with product/order writes and their validation.
        db.execute(text("BEGIN IMMEDIATE"))
        item = db.query(InventoryOption).filter_by(id=option_id, kind=kind).first() if option_id is not None else InventoryOption(kind=kind)
        if item is None:
            raise FinanceError("گزینه موردنظر پیدا نشد.", 404)
        name = data.name
        if kind == "units" and option_id is not None and name == normalize_text(item.name):
            name = item.name
        if kind == "units" and option_id is not None and item.name != name:
            if db.query(Product.id).filter(Product.unit == item.name).first() or db.query(OrderItem.id).filter(OrderItem.unit == item.name).first():
                raise FinanceError("نام واحد استفاده‌شده قابل تغییر نیست. واحد جدید اضافه کنید؛ واحد قبلی را می‌توانید غیرفعال کنید.", 409)
        item.name = name
        item.active = data.active
        db.add(item)
        db.flush()
        result = option_data(item)
        db.commit()
        return result
    except IntegrityError:
        db.rollback()
        raise FinanceError("این عنوان قبلاً ثبت شده است.", 409)
    except Exception:
        db.rollback()
        raise
