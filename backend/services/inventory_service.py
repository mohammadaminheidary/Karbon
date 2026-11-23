from sqlalchemy.exc import IntegrityError
from sqlalchemy import text, func
from sqlalchemy.orm import aliased
from models.inventory import Brand, InventoryOption, Purchase, PurchaseItem
from models.order import PRODUCT_BRAND_CHECK, Product, OrderItem
from services.finance_service import FinanceError, require
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
DEFAULT_CATEGORY_NAME = "عمومی"


def initialize_category_storage(engine):
    """Keep all existing category IDs and promote the flat catalog to main categories."""
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        for table, additions in {
            "inventory_options": {"parent_id": "INTEGER REFERENCES inventory_options(id) ON DELETE RESTRICT"},
            "purchases": {"category_parent_name": "VARCHAR(80)"},
            "purchase_items": {"category_parent_name": "VARCHAR(80)"},
            "order_items": {"category_id": "INTEGER REFERENCES inventory_options(id) ON DELETE RESTRICT"},
        }.items():
            columns = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({table})")}
            for column, definition in additions.items():
                if column not in columns:
                    connection.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_inventory_options_parent_id ON inventory_options(parent_id)")
        for table in ("purchases", "purchase_items", "order_items"):
            connection.exec_driver_sql(f"CREATE INDEX IF NOT EXISTS ix_{table}_category_id ON {table}(category_id)")
        for event in ("INSERT", "UPDATE OF parent_id, kind"):
            trigger = event.split()[0].lower()
            connection.exec_driver_sql(f"""CREATE TRIGGER IF NOT EXISTS inventory_category_hierarchy_{trigger}
                BEFORE {event} ON inventory_options
                WHEN (NEW.parent_id IS NOT NULL AND (
                        NEW.kind != 'categories' OR NEW.parent_id = NEW.id OR NOT EXISTS (
                            SELECT 1 FROM inventory_options
                            WHERE id = NEW.parent_id AND kind = 'categories' AND parent_id IS NULL)))
                    OR ((NEW.parent_id IS NOT NULL OR NEW.kind != 'categories') AND EXISTS (
                        SELECT 1 FROM inventory_options WHERE parent_id = NEW.id))
                BEGIN SELECT RAISE(ABORT, 'invalid category hierarchy'); END""")


def initialize_brand_storage(engine):
    """Add optional brand links and receipt fields without rewriting history."""
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        for table, additions in {
            "products": {
                "requires_brand": "BOOLEAN NOT NULL DEFAULT 0",
                "brand_id": f"INTEGER REFERENCES brands(id) ON DELETE RESTRICT CHECK ({PRODUCT_BRAND_CHECK})",
            },
            "purchases": {"brand_name": "VARCHAR(80)"},
            "purchase_items": {"brand_name": "VARCHAR(80)"},
            "order_items": {"brand_name": "VARCHAR(80)"},
        }.items():
            columns = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({table})")}
            for column, definition in additions.items():
                if column not in columns:
                    connection.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_products_brand_id ON products(brand_id)")


def list_brands(db):
    return [{"id": item.id, "name": item.name} for item in db.query(Brand).order_by(Brand.name, Brand.id)]


def save_brand(db, data, brand_id=None):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        item = require(db, Brand, brand_id, "برند") if brand_id is not None else Brand()
        item.name = data.name
        db.add(item)
        db.flush()
        result = {"id": item.id, "name": item.name}
        db.commit()
        return result
    except IntegrityError:
        db.rollback()
        raise FinanceError("این برند قبلاً ثبت شده است.", 409)
    except Exception:
        db.rollback()
        raise


def delete_brand(db, brand_id):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        item = require(db, Brand, brand_id, "برند")
        if db.query(Product.id).filter_by(brand_id=brand_id).first():
            raise FinanceError("این برند به کالا اختصاص دارد. ابتدا برند کالا را تغییر دهید یا بردارید.", 409)
        db.delete(item)
        db.commit()
        return {"id": brand_id, "deleted": True}
    except Exception:
        db.rollback()
        raise


def initialize_purchase_storage(engine):
    """Add a category to legacy products without changing stock or invoices."""
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(products)")}
        if "category_id" not in columns:
            connection.exec_driver_sql("ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES inventory_options(id) ON DELETE RESTRICT")
        connection.exec_driver_sql("CREATE TABLE IF NOT EXISTS inventory_purchase_migrations (version INTEGER PRIMARY KEY)")
        if not connection.exec_driver_sql("SELECT version FROM inventory_purchase_migrations WHERE version=1").first():
            connection.execute(text("INSERT OR IGNORE INTO inventory_options (kind, name, active) VALUES ('categories', :name, 1)"), {"name": DEFAULT_CATEGORY_NAME})
            connection.execute(text("UPDATE products SET category_id=(SELECT id FROM inventory_options WHERE kind='categories' AND name=:name) WHERE category_id IS NULL"), {"name": DEFAULT_CATEGORY_NAME})
            connection.exec_driver_sql("INSERT INTO inventory_purchase_migrations (version) VALUES (1)")
        if not connection.exec_driver_sql("SELECT version FROM inventory_purchase_migrations WHERE version=2").first():
            # Backfill receipt rows without replaying historical stock movements.
            connection.exec_driver_sql("""INSERT INTO purchase_items
                (purchase_id, position, product_id, category_id, category_name, category_parent_name, product_name, brand_name, unit, quantity, purchase_price)
                SELECT p.id, 1, p.product_id, p.category_id, p.category_name, p.category_parent_name, p.product_name, p.brand_name, p.unit, p.quantity, p.purchase_price
                FROM purchases p WHERE NOT EXISTS (SELECT 1 FROM purchase_items i WHERE i.purchase_id=p.id)""")
            connection.exec_driver_sql("INSERT INTO inventory_purchase_migrations (version) VALUES (2)")
        connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_products_category_id ON products(category_id)")


def category_path(name, parent_name):
    return f"{parent_name} / {name}" if parent_name else name


def with_category_names(query, category_id):
    category, parent = aliased(InventoryOption), aliased(InventoryOption)
    return query.outerjoin(category, (category.id == category_id) & (category.kind == "categories")).outerjoin(
        parent, parent.id == category.parent_id,
    ).add_columns(category.name.label("category_name"), parent.name.label("category_parent_name"))


def require_category(db, category_id, *, current=None):
    if category_id is None:
        category_id = current
        if category_id is None:
            # Old product clients omit this field. Prefer the original default,
            # with an active main category as a fallback if it was renamed or removed.
            default = db.query(InventoryOption.id).filter_by(kind="categories", parent_id=None, active=True).order_by(
                (InventoryOption.name == DEFAULT_CATEGORY_NAME).desc(), InventoryOption.id,
            ).first()
            category_id = default.id if default else None
    parent_alias = aliased(InventoryOption)
    result = db.query(InventoryOption, parent_alias).outerjoin(
        parent_alias, parent_alias.id == InventoryOption.parent_id,
    ).filter(InventoryOption.id == category_id, InventoryOption.kind == "categories").first()
    if result is None:
        raise FinanceError("دسته‌بندی فعال کالا را از تنظیمات انتخاب کنید.", 422)
    category, parent = result
    if category.id != current and (not category.active or (parent is not None and not parent.active)):
        raise FinanceError("دسته‌بندی فعال کالا را از تنظیمات انتخاب کنید.", 422)
    return category, parent


def next_purchase_number(db):
    # A preview only. Final allocation happens under the purchase write lock.
    return f"PUR-{(db.query(func.max(Purchase.id)).scalar() or 0) + 1:06d}"


def purchase_category_data(item):
    return {"category_path": category_path(item.category_name, item.category_parent_name)}


def purchase_data(db, item):
    rows = [{**{column.name: getattr(row, column.name) for column in PurchaseItem.__table__.columns},
             **purchase_category_data(row), "total": row.quantity * row.purchase_price}
            for row in db.query(PurchaseItem).filter_by(purchase_id=item.id).order_by(PurchaseItem.position).all()]
    return {
        **{column.name: getattr(item, column.name) for column in Purchase.__table__.columns if column.name != "request_fingerprint"},
        **purchase_category_data(item),
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
            category, parent = require_category(db, row.category_id)
            product = db.query(Product).filter_by(id=row.product_id, active=True, deleted_at=None).first()
            if product is None or product.category_id != category.id:
                raise FinanceError(f"کالای فعال ردیف {position} را از دسته‌بندی انتخاب‌شده انتخاب کنید.", 422)
            require_enabled_unit(db, product.unit)
            if product.stock is None:
                raise FinanceError(f"کالای ردیف {position} باید دارای کنترل موجودی باشد.", 422)
            quantities[product.id] += row.quantity
            products[product.id] = product
            records.append({**row.model_dump(), "position": position, "product_name": product.name,
                            "category_name": category.name, "category_parent_name": parent.name if parent else None,
                            "brand_name": product.brand.name if product.brand else None, "unit": product.unit})
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


def option_data(item, parent=None):
    data = {"id": item.id, "name": item.name, "active": item.active}
    if item.kind == "categories":
        data.update(parent_id=item.parent_id,
                    path=category_path(item.name, parent.name if parent else None),
                    selectable=item.active and (parent is None or parent.active))
    return data


def list_options(db):
    result = {"categories": [], "units": []}
    items = {item.id: item for item in db.query(InventoryOption).order_by(InventoryOption.id)}
    for item in items.values():
        result[item.kind].append(option_data(item, items.get(item.parent_id)))
    return result


def save_option(db, kind, data, option_id=None):
    db.rollback()
    try:
        # Serialize settings changes with product/order writes and their validation.
        db.execute(text("BEGIN IMMEDIATE"))
        item = db.query(InventoryOption).filter_by(id=option_id, kind=kind).first() if option_id is not None else InventoryOption(kind=kind)
        if item is None:
            raise FinanceError("گزینه موردنظر پیدا نشد.", 404)
        parent = None
        if kind == "categories":
            # Older PUT clients send only the name and enabled state.
            parent_id = data.parent_id if "parent_id" in data.model_fields_set else item.parent_id
            if parent_id is not None:
                parent = db.query(InventoryOption).filter_by(id=parent_id, kind="categories", parent_id=None).first()
                if parent is None or parent_id == option_id:
                    raise FinanceError("دستهٔ اصلی معتبری برای این زیردسته انتخاب کنید.", 422)
                if option_id is not None and db.query(InventoryOption.id).filter_by(parent_id=option_id).first():
                    raise FinanceError("برای تبدیل دستهٔ اصلی به زیردسته، ابتدا زیردسته‌های آن را جابه‌جا کنید.", 409)
            item.parent_id = parent_id
        elif "parent_id" in data.model_fields_set:
            raise FinanceError("واحد نمی‌تواند دستهٔ اصلی داشته باشد.", 422)
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
        result = option_data(item, parent)
        db.commit()
        return result
    except IntegrityError:
        db.rollback()
        raise FinanceError("این عنوان قبلاً ثبت شده است.", 409)
    except Exception:
        db.rollback()
        raise


def delete_category(db, category_id):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        item = db.query(InventoryOption).filter_by(id=category_id, kind="categories").first()
        if item is None:
            raise FinanceError("دسته‌بندی موردنظر پیدا نشد.", 404)
        if db.query(InventoryOption.id).filter_by(parent_id=category_id).first():
            raise FinanceError("این دسته دارای زیردسته است. ابتدا زیردسته‌های آن را جابه‌جا یا حذف کنید.", 409)
        for model in (Product, Purchase, PurchaseItem, OrderItem):
            if db.query(model.id).filter_by(category_id=category_id).first():
                raise FinanceError("این دسته‌بندی در کالا، خرید یا فروش استفاده شده است. می‌توانید آن را غیرفعال کنید.", 409)
        db.delete(item)
        db.commit()
        return {"id": category_id, "deleted": True}
    except Exception:
        db.rollback()
        raise
