from collections import Counter
from sqlalchemy.exc import IntegrityError
from sqlalchemy import String, cast, func, or_, select, text
from sqlalchemy.orm import aliased, joinedload
from sqlalchemy.schema import CreateTable
from database import read_snapshot
from models.fiscal_year import InventoryChange
from models.inventory import Brand, InventoryOption, Purchase, PurchaseItem, PurchasePayment
from models.customer import Customer
from services import invoice_settings_service as design
from services import purchase_payments
from models.order import PRODUCT_BRAND_CHECK, Product, OrderItem
from services.finance_service import FinanceError, require
from services.fiscal_period import ensure_open, in_active_period
from schemas.customer_schema import normalize_text
import hashlib
import json
import jdatetime
from datetime import datetime, timezone
from services.inventory_stock import StockPosting, line_quantities, opposite, post_warehouse_stock, quantities_for, warehouse_balances
from security.password import verify_password


DEFAULT_UNITS = (
    "عدد", "بسته", "کیلوگرم", "گرم", "لیتر", "میلی‌لیتر", "متر",
    "سانتی‌متر", "متر مربع", "متر مکعب", "تن", "رول", "جعبه", "کارتن", "ساعت",
)
DEFAULT_CATEGORY_NAME = "عمومی"
WAREHOUSE_CATEGORIES = "warehouse-categories"
PURCHASE_REVISION_COLUMNS = {
    "revision": "INTEGER NOT NULL DEFAULT 1", "last_edit_id": "VARCHAR(36)",
    "last_edit_fingerprint": "VARCHAR(64)", "deleted_at": "DATETIME",
    "description": "VARCHAR(1000) CHECK (description IS NULL OR length(description) <= 1000)",
    "discount_override": "BIGINT CHECK (discount_override IS NULL OR discount_override BETWEEN 0 AND 999999999999)",
}
PURCHASE_INTERNAL_FIELDS = {"request_fingerprint", "invoice_snapshot", "last_edit_id", "last_edit_fingerprint"}


def upgrade_purchase_revisions(connection):
    columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(purchases)")}
    for column, definition in PURCHASE_REVISION_COLUMNS.items():
        if column not in columns:
            connection.exec_driver_sql(f"ALTER TABLE purchases ADD COLUMN {column} {definition}")


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
    upgrade_category_catalog(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        for event in ("INSERT", "UPDATE OF parent_id, kind, deleted_at"):
            trigger = event.split()[0].lower()
            connection.exec_driver_sql(f"""CREATE TRIGGER IF NOT EXISTS inventory_category_hierarchy_{trigger}
                BEFORE {event} ON inventory_options
                WHEN (NEW.deleted_at IS NULL AND NEW.parent_id IS NOT NULL AND (
                        NEW.kind = 'units' OR NEW.parent_id = NEW.id OR NOT EXISTS (
                            SELECT 1 FROM inventory_options
                            WHERE id = NEW.parent_id AND kind = NEW.kind AND parent_id IS NULL AND deleted_at IS NULL)))
                    OR (EXISTS (SELECT 1 FROM inventory_options
                        WHERE parent_id = NEW.id AND deleted_at IS NULL
                        AND (NEW.parent_id IS NOT NULL OR kind != NEW.kind OR NEW.deleted_at IS NOT NULL)))
                BEGIN SELECT RAISE(ABORT, 'invalid category hierarchy'); END""")


def upgrade_category_catalog(engine):
    """Expand the catalog's SQLite CHECK constraint while keeping referenced IDs."""
    with engine.connect() as connection:
        foreign_keys = connection.exec_driver_sql("PRAGMA foreign_keys").scalar()
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        try:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(inventory_options)")}
            if "deleted_at" in columns:
                return
            sequence = connection.exec_driver_sql("SELECT seq FROM sqlite_sequence WHERE name='inventory_options'").scalar()
            definition = str(CreateTable(InventoryOption.__table__).compile(dialect=connection.dialect))
            connection.exec_driver_sql(definition.replace("CREATE TABLE inventory_options (", "CREATE TABLE inventory_options_migration (", 1))
            connection.exec_driver_sql("""INSERT INTO inventory_options_migration (id, kind, name, active, parent_id)
                SELECT id, kind, name, active, parent_id FROM inventory_options""")
            connection.exec_driver_sql("DROP TABLE inventory_options")
            connection.exec_driver_sql("ALTER TABLE inventory_options_migration RENAME TO inventory_options")
            if sequence is not None:
                connection.exec_driver_sql("UPDATE sqlite_sequence SET seq=MAX(seq, ?) WHERE name='inventory_options'", (sequence,))
                connection.exec_driver_sql("INSERT INTO sqlite_sequence (name, seq) SELECT 'inventory_options', ? "
                                           "WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='inventory_options')", (sequence,))
            for index in InventoryOption.__table__.indexes:
                index.create(connection)
            connection.exec_driver_sql("CREATE INDEX ix_inventory_options_parent_id ON inventory_options(parent_id)")
            if connection.exec_driver_sql("PRAGMA foreign_key_check").first():
                raise RuntimeError("Category migration violated a foreign key")
            connection.commit()
        finally:
            connection.rollback()
            connection.exec_driver_sql(f"PRAGMA foreign_keys={foreign_keys}")


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
        upgrade_purchase_revisions(connection)
        columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(products)")}
        if "category_id" not in columns:
            connection.exec_driver_sql("ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES inventory_options(id) ON DELETE RESTRICT")
        if "warehouse_category_id" not in columns:
            connection.exec_driver_sql("ALTER TABLE products ADD COLUMN warehouse_category_id INTEGER REFERENCES inventory_options(id) ON DELETE RESTRICT")
        if "catalog" not in columns:
            connection.exec_driver_sql("ALTER TABLE products ADD COLUMN catalog VARCHAR(12) NOT NULL DEFAULT 'sales' CHECK (catalog IN ('sales', 'warehouse'))")
        if "legacy_product_id" not in columns:
            connection.exec_driver_sql("ALTER TABLE products ADD COLUMN legacy_product_id INTEGER")
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
        if not connection.exec_driver_sql("SELECT version FROM inventory_purchase_migrations WHERE version=3").first():
            migrate_warehouse_categories(connection)
            connection.exec_driver_sql("INSERT INTO inventory_purchase_migrations (version) VALUES (3)")
        connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_products_category_id ON products(category_id)")
        connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_products_warehouse_category_id ON products(warehouse_category_id)")


def migrate_warehouse_categories(connection):
    legacy = connection.exec_driver_sql("""SELECT id, name, active, parent_id
        FROM inventory_options WHERE kind='categories' ORDER BY parent_id IS NOT NULL, id""").all()
    mapping = {}
    names = set()
    for category_id, old_name, active, parent_id in legacy:
        base = normalize_text(old_name)[:80] or DEFAULT_CATEGORY_NAME
        name = base
        suffix_number = 1
        while name.casefold() in names:
            suffix_number += 1
            suffix = f" ({suffix_number})"
            name = base[:80 - len(suffix)] + suffix
        names.add(name.casefold())
        result = connection.exec_driver_sql("""INSERT INTO inventory_options (kind, name, active, parent_id)
            VALUES (?, ?, ?, ?)""", (WAREHOUSE_CATEGORIES, name, active, mapping.get(parent_id)))
        mapping[category_id] = result.lastrowid
    if mapping:
        connection.exec_driver_sql("UPDATE products SET warehouse_category_id=? WHERE category_id=?",
                                   [(warehouse_id, category_id) for category_id, warehouse_id in mapping.items()])


def initialize_warehouse_constraints(engine):
    # Run after the older product-table rebuild, which drops product triggers.
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        for event in ("INSERT", "UPDATE OF warehouse_category_id"):
            action = event.split()[0].lower()
            connection.exec_driver_sql(f"""CREATE TRIGGER IF NOT EXISTS product_warehouse_category_{action}
                BEFORE {event} ON products
                WHEN NEW.warehouse_category_id IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM inventory_options WHERE id = NEW.warehouse_category_id
                    AND kind = 'warehouse-categories' AND deleted_at IS NULL)
                BEGIN SELECT RAISE(ABORT, 'invalid warehouse category'); END""")


def category_path(name, parent_name):
    return f"{parent_name} / {name}" if parent_name else name


def with_category_names(query, category_id, kind="categories", prefix="category"):
    category, parent = aliased(InventoryOption), aliased(InventoryOption)
    return query.outerjoin(category, (category.id == category_id) & (category.kind == kind)).outerjoin(
        parent, parent.id == category.parent_id,
    ).add_columns(category.name.label(f"{prefix}_name"), parent.name.label(f"{prefix}_parent_name"))


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
    return validate_category(category_query(db).filter(InventoryOption.id == category_id).first(), current=current)


def category_query(db, kind="categories"):
    parent = aliased(InventoryOption)
    return db.query(InventoryOption, parent).outerjoin(
        parent, parent.id == InventoryOption.parent_id,
    ).filter(InventoryOption.kind == kind, InventoryOption.deleted_at.is_(None))


def require_warehouse_category(db, category_id, *, current=None):
    if category_id is None:
        return None, None
    result = category_query(db, WAREHOUSE_CATEGORIES).filter(InventoryOption.id == category_id).first()
    if result is None or (category_id != current and not option_data(*result)["selectable"]):
        raise FinanceError("دسته‌بندی فعال انبار را از تنظیمات انتخاب کنید.", 422)
    return result


def validate_category(result, *, current=None):
    if result is None:
        raise FinanceError("دسته‌بندی فعال کالا را از تنظیمات انتخاب کنید.", 422)
    category, parent = result
    if category.id != current and (not category.active or (parent is not None and not parent.active)):
        raise FinanceError("دسته‌بندی فعال کالا را از تنظیمات انتخاب کنید.", 422)
    return category, parent


def products_by_id(db, ids):
    return {product.id: product for product in db.query(Product).options(joinedload(Product.brand))
            .filter(Product.id.in_(ids))}


def purchase_product_reference(product_id, legacy_id):
    return or_(
        select(Purchase.id).where(Purchase.product_id.in_([product_id, legacy_id])).exists(),
        select(PurchaseItem.id).where(PurchaseItem.product_id.in_([product_id, legacy_id])).exists(),
    )


def warehouse_removal_reason(has_purchase, stock):
    if has_purchase:
        return "برای این کالا فاکتور خرید ثبت شده است."
    if stock:
        return "این کالا در انبار موجودی ثبت‌شده دارد."
    return None


def warehouse_product_state(db, ids=None):
    balances = warehouse_balances()
    if ids is not None:
        balances = balances.where(InventoryChange.product_id.in_(ids))
    balance = balances.subquery()
    stock = func.coalesce(balance.c.quantity, 0)
    has_purchase = purchase_product_reference(Product.id, Product.legacy_product_id)
    query = db.query(Product, stock, has_purchase).outerjoin(
        balance, balance.c.product_id == Product.id,
    ).filter(Product.deleted_at.is_(None))
    if ids is not None:
        query = query.filter(Product.id.in_(ids))
    return query, stock, has_purchase


def warehouse_products(db, catalog_only=False):
    query, stock, has_purchase = warehouse_product_state(db)
    migrated = aliased(Product)
    query = query.filter(Product.catalog == "warehouse" if catalog_only else or_(
        Product.catalog == "warehouse", Product.warehouse_category_id.is_not(None), stock != 0,
        has_purchase & ~select(migrated.id).where(migrated.legacy_product_id == Product.id).exists(),
    ))
    query = with_category_names(query, Product.warehouse_category_id, WAREHOUSE_CATEGORIES).outerjoin(Product.brand).add_columns(Brand.name)
    return [{
        "id": product.id, "name": product.name, "product_code": product.product_code, "brand_name": brand_name,
        "warehouse_category_id": product.warehouse_category_id, "warehouse_category_path": category_path(category, parent),
        "unit": product.unit, "stock": quantity, "active": product.active, "price": product.price,
        "brand_id": product.brand_id, "requires_brand": product.requires_brand, "revision": product.revision,
        "catalog": product.catalog,
        "removal_blocked_reason": warehouse_removal_reason(purchased, quantity),
    } for product, quantity, purchased, category, parent, brand_name in query.order_by(Product.id)]


def remove_warehouse_products(db, product_ids, data, user):
    if not verify_password(data.password, user.password_hash):
        raise FinanceError("رمز حساب کاربری صحیح نیست.", 403)
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        product_ids = list(dict.fromkeys(product_ids))
        ids = select(func.json_each(json.dumps(product_ids)).table_valued("value").c.value)
        query, _, _ = warehouse_product_state(db, ids)
        rows = query.order_by(Product.id).all()
        if len(rows) != len(product_ids):
            raise FinanceError("یک یا چند کالای انتخاب‌شده پیدا نشد.", 404)
        for product, stock, has_purchase in rows:
            reason = warehouse_removal_reason(has_purchase, stock)
            if reason:
                raise FinanceError(f"«{product.name}» قابل حذف از انبار نیست. {reason}", 409)
            if product.catalog == "warehouse":
                db.delete(product)
            elif product.warehouse_category_id is not None:
                product.warehouse_category_id = None
                product.revision += 1
        db.commit()
        return {"product_ids": product_ids, "removed": True}
    except Exception:
        db.rollback()
        raise


def next_purchase_number(db):
    # A preview only. Final allocation happens under the purchase write lock.
    value = (db.query(func.max(Purchase.id)).scalar() or 0) + 1
    while db.query(Purchase.id).filter_by(invoice_number=f"PUR-{value:06d}").first():
        value += 1
    return f"PUR-{value:06d}"


def purchase_category_data(item):
    return {"category_path": category_path(item.category_name, item.category_parent_name)}


def purchase_data(db, item, *, items=None):
    if items is None:
        items = db.query(PurchaseItem).filter_by(purchase_id=item.id).order_by(PurchaseItem.position)
    rows = [{**{column.name: getattr(row, column.name) for column in PurchaseItem.__table__.columns},
             **purchase_category_data(row), "total": row.quantity * row.purchase_price}
            for row in items]
    subtotal = sum(row["total"] for row in rows)
    total = subtotal - item.discount + item.tax + item.shipping
    payments = purchase_payments.read_payments(db, item.id)
    return {
        **{column.name: getattr(item, column.name) for column in Purchase.__table__.columns if column.name not in PURCHASE_INTERNAL_FIELDS},
        **purchase_category_data(item),
        "jalali_date": jdatetime.date.fromgregorian(date=item.purchase_date).strftime("%Y/%m/%d"),
        "rows": rows,
        "row_count": len(rows),
        "total_quantity": sum(row["quantity"] for row in rows),
        "subtotal": subtotal, "total": total, "payments": payments,
        **purchase_payments.balance(total, sum(payment["amount"] for payment in payments)),
        "created_at": item.created_at.replace(tzinfo=timezone.utc),
    }


def get_purchase(db, purchase_id, for_edit=False):
    item = require(db, Purchase, purchase_id, "خرید")
    result = purchase_data(db, item)
    if not for_edit:
        return result
    ensure_open(db, item.purchase_date)
    mapped = migrated_warehouse_products(db, {row["product_id"] for row in result["rows"]})
    for row in result["rows"]:
        if product := mapped.get(row["product_id"]):
            row["product_id"] = product.id
    supplier = db.get(Customer, item.supplier_id) if item.supplier_id else None
    rules = (item.invoice_snapshot or {}).get("finance_rules")
    return {**result, "supplier": design.party_data(supplier),
            "finance": rules or design.preferences(db).data["purchase_finance"]}


def list_purchase_invoices(db, search, skip, limit, history=False):
    supplier_name = (Customer.first_name + " " + Customer.last_name).label("supplier_name")
    query = db.query(Purchase.id, Purchase.invoice_number, Purchase.purchase_date, Purchase.discount,
                     Purchase.tax, Purchase.shipping, supplier_name).outerjoin(Customer, Customer.id == Purchase.supplier_id)
    query = query.filter(Purchase.deleted_at.is_(None))
    active = in_active_period(Purchase.purchase_date)
    if history:
        query = query.add_columns(active.label("editable"))
    else:
        query = query.filter(active)
    term = normalize_text(search)
    if term:
        pattern = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.filter(or_(Purchase.invoice_number.like(pattern, escape="\\"),
                                 supplier_name.like(pattern, escape="\\"),
                                 cast(Customer.customer_code, String).like(pattern, escape="\\")))
    total = query.count()
    rows = query.order_by(Purchase.id.desc()).offset(skip).limit(limit).all()
    ids = [row.id for row in rows]
    subtotals = dict(db.query(PurchaseItem.purchase_id, func.sum(PurchaseItem.quantity * PurchaseItem.purchase_price))
                     .filter(PurchaseItem.purchase_id.in_(ids)).group_by(PurchaseItem.purchase_id).all()) if ids else {}
    paid = dict(db.execute(purchase_payments.paid_totals().where(PurchasePayment.purchase_id.in_(ids))).all()) if ids else {}
    return {"total": total, "items": [
        {"id": row.id, "invoice_number": row.invoice_number, "supplier_name": row.supplier_name,
         "jalali_date": jdatetime.date.fromgregorian(date=row.purchase_date).strftime("%Y/%m/%d"),
         "total": subtotals.get(row.id, 0) - row.discount + row.tax + row.shipping,
         **purchase_payments.balance(subtotals.get(row.id, 0) - row.discount + row.tax + row.shipping, paid.get(row.id, 0)),
         **({"editable": row.editable} if history else {})} for row in rows
    ]}


def purchase_invoice(db, purchase_id, *, include_deleted=False):
    item = require(db, Purchase, purchase_id, "خرید", include_deleted=include_deleted)
    if item.invoice_snapshot:
        snapshot = {key: value for key, value in item.invoice_snapshot.items() if key != "finance_rules"}
        payments = purchase_payments.read_payments(db, item.id)
        return design.with_presentation(db, {**snapshot, "payments": payments,
            **purchase_payments.balance(snapshot["total"], sum(payment["amount"] for payment in payments))})
    # Legacy purchases did not have a designer or a rendered invoice.
    result = purchase_data(db, item)
    return {**build_purchase_invoice(result), "payments": result["payments"],
            **purchase_payments.balance(result["total"], result["paid"])}


def archived_purchase_invoice(db, archive, receipt):
    purchase_id = receipt["id"]
    issuance = archive.get("purchase_issuance", {}).get(str(purchase_id))
    if issuance is None:
        current = db.get(Purchase, purchase_id)
        if current is not None and current.revision == 1:
            result = purchase_invoice(db, purchase_id, include_deleted=True)
            return {**result, "payments": [], **purchase_payments.balance(result["total"], 0)}
    rows = [row for row in archive["purchase_items"] if row["purchase_id"] == purchase_id]
    codes = {row["id"]: row.get("product_code") for row in archive["products"]}
    result = build_purchase_invoice({"tax": 0, "shipping": 0, "discount": 0, **receipt,
                                     "subtotal": sum(row["total"] for row in rows), "rows": rows})
    for item in result["items"]:
        item["product_code"] = codes.get(item["product_id"])
    if issuance:
        result.update(issuance)
    elif receipt.get("supplier_id"):
        supplier = next((row for row in archive["customers"] if row["id"] == receipt["supplier_id"]), None)
        if supplier:
            result["supplier"] = {"code": supplier["customer_code"],
                                  "name": f"{supplier['first_name']} {supplier['last_name']}",
                                  "phone_numbers": supplier["phone_numbers"], "address": supplier["address"]}
    finances = archive.get("purchase_finances", {}).get(str(purchase_id))
    return design.with_presentation(db, {**result, **(finances or {"payments": [], **purchase_payments.balance(result["total"], 0)})})


def build_purchase_invoice(result, presentation=None, supplier=None, products=None):
    items = [{**row, "unit_price": row["purchase_price"],
              "product_code": products[row["product_id"]].product_code if products else None} for row in result["rows"]]
    invoice = {key: result[key] for key in ("id", "jalali_date", "subtotal", "discount", "tax", "shipping", "total")}
    invoice.update(invoice_code=result["invoice_number"], kind="purchase", items=items, supplier=design.party_data(supplier),
                   description=result.get("description"), status="completed", version=1)
    if presentation:
        invoice["presentation"] = presentation
    return invoice


def migrated_warehouse_products(db, ids):
    return {product.legacy_product_id: product for product in db.query(Product).options(joinedload(Product.brand))
            .filter(Product.catalog == "warehouse", Product.legacy_product_id.in_(ids))}


def purchase_rows(db, rows, previous_rows=(), *, catalog_only=False):
    # The original API accepted product categories. Warehouse purchases use
    # warehouse IDs from the same catalog and validate the corresponding link.
    parent = aliased(InventoryOption)
    categories = {category.id: (category, main) for category, main in db.query(InventoryOption, parent)
                  .outerjoin(parent, parent.id == InventoryOption.parent_id)
                  .filter(InventoryOption.kind != "units", InventoryOption.id.in_({row.category_id for row in rows}))}
    previous = {(row.category_id, row.product_id): row for row in previous_rows}
    products = products_by_id(db, {row.product_id for row in rows})
    mapped = {} if catalog_only else migrated_warehouse_products(db, products.keys())
    units = enabled_unit_names(db)
    records = []
    for position, row in enumerate(rows, 1):
        product = products.get(row.product_id)
        legacy = product
        product = mapped.get(row.product_id, product)
        category, main = categories.get(row.category_id, (None, None))
        warehouse = category is not None and category.kind == WAREHOUSE_CATEGORIES
        historical = None
        if product and product.catalog == "warehouse":
            historical = previous.get((row.category_id, product.id)) or previous.get((row.category_id, product.legacy_product_id))
        elif warehouse:
            historical = previous.get((row.category_id, row.product_id))
        assigned = (product.warehouse_category_id if warehouse else legacy.category_id) if product else None
        if not historical:
            if category is None or category.deleted_at is not None:
                raise FinanceError("دسته‌بندی فعال کالا را از تنظیمات انتخاب کنید.", 422)
            validate_category((category, main))
        if (product is None or (catalog_only and product.catalog != "warehouse")
                or not product.active or product.deleted_at is not None or (not historical and assigned != row.category_id)):
            raise FinanceError(f"کالای فعال ردیف {position} را از دسته‌بندی انتخاب‌شده انتخاب کنید.", 422)
        require_enabled_unit(db, product.unit, enabled=units)
        if row.unit is not None and normalize_text(row.unit) != normalize_text(product.unit):
            raise FinanceError(f"واحد ردیف {position} با واحد کالا مطابقت ندارد. فهرست کالاها را بروزرسانی کنید.", 422)
        products[product.id] = product
        records.append({**row.model_dump(exclude={"unit"}), "product_id": product.id, "position": position, "product_name": product.name,
                        "category_name": historical.category_name if historical else category.name,
                        "category_parent_name": historical.category_parent_name if historical else (main.name if main else None),
                        "brand_name": product.brand.name if product.brand else None, "unit": product.unit})
    return records, products


def purchase_stock(db, purchase):
    quantities = quantities_for(db, f"warehouse:purchase:{purchase.id}:{purchase.revision}:apply")
    # Legacy purchases always posted tracked stock. The immutable receipt
    # quantities provide the source when the older journal has no reference.
    if quantities:
        return quantities
    quantities = line_quantities(db.query(PurchaseItem).filter_by(purchase_id=purchase.id))
    mapped = migrated_warehouse_products(db, quantities.keys())
    result = Counter()
    for product_id, quantity in quantities.items():
        result[mapped[product_id].id if product_id in mapped else product_id] += quantity
    return result


def save_purchase(db, data, purchase_id=None):
    optional = {"discount", "description"} - data.model_fields_set
    if not data.payments:
        optional.add("payments")
    values = data.model_dump(mode="json", exclude={"request_id", "invoice_settings_revision", "catalog_only"} | optional)
    values["rows"] = [row.model_dump(exclude_none=True) for row in data.rows]
    fingerprint = hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()
    fingerprints = {fingerprint}
    if data.invoice_number is None and data.supplier_id is None and optional == {"discount", "description", "payments"}:
        legacy = {key: values[key] for key in ("purchase_date", "rows")}
        fingerprints.add(hashlib.sha256(json.dumps(legacy, sort_keys=True).encode()).hexdigest())
        if len(data.rows) == 1:
            legacy = {"purchase_date": data.purchase_date.isoformat(), **values["rows"][0]}
            fingerprints.add(hashlib.sha256(json.dumps(legacy, sort_keys=True).encode()).hexdigest())
    db.rollback()
    try:
        # Serialize stock increments with sales, Settings edits and other purchases.
        db.execute(text("BEGIN IMMEDIATE"))
        request_id = str(data.request_id)
        previous = db.query(Purchase).filter_by(request_id=request_id).first() if purchase_id is None else None
        if previous is not None:
            if previous.deleted_at is not None or previous.revision != 1:
                raise FinanceError("این خرید پس از ثبت تغییر کرده است. فهرست فاکتورها را بررسی کنید.", 409, code="PURCHASE_CHANGED")
            if previous.request_fingerprint not in fingerprints:
                raise FinanceError("این درخواست قبلاً با اطلاعات دیگری ثبت شده است. نتیجه خرید را بررسی کنید.", 409, code="PURCHASE_CHANGED")
            result = purchase_data(db, previous)
            db.commit()
            return result
        item = require(db, Purchase, purchase_id, "خرید") if purchase_id is not None else None
        if item is not None and item.last_edit_id == request_id:
            if item.last_edit_fingerprint != fingerprint:
                raise FinanceError("شناسه درخواست قبلاً برای ویرایش دیگری استفاده شده است.", 409, code="PURCHASE_CHANGED")
            result = purchase_data(db, item)
            db.commit()
            return result
        if item is not None and (item.revision != data.revision or data.invoice_number not in (None, item.invoice_number)):
            raise FinanceError("خرید تغییر کرده است. فاکتور را دوباره برای ویرایش باز کنید.", 409, code="PURCHASE_CHANGED")
        ensure_open(db, data.purchase_date, item.purchase_date if item else data.purchase_date)
        settings = design.preferences(db)
        design.check_workflow_revision(settings, data.invoice_settings_revision)
        supplier = require(db, Customer, data.supplier_id, "تأمین‌کننده") if data.supplier_id else None
        snapshot = (item.invoice_snapshot or {}) if item else {}
        previous_supplier_id = item.supplier_id if item else None
        rules = snapshot.get("finance_rules", settings.data["purchase_finance"])
        override = data.discount if item is None or "discount" in data.model_fields_set else item.discount_override
        totals = design.calculate_totals(sum(row.quantity * row.purchase_price for row in data.rows), rules, override)
        existing = purchase_payments.live_payments(db, item.id).all() if item is not None else []
        if item is not None and data.payments:
            raise FinanceError("پرداخت‌های جدید را از جزئیات فاکتور ثبت کنید.", 422)
        if any(tx.transaction_date < data.purchase_date for _, tx in existing):
            raise FinanceError("تاریخ فاکتور نباید پس از تاریخ پرداخت ثبت‌شده باشد.", 422)
        if sum(tx.amount for _, tx in existing) + sum(payment.amount for payment in data.payments) > totals["total"]:
            raise FinanceError("مبلغ پرداخت از مبلغ نهایی فاکتور بیشتر است.", 422)
        previous_rows = db.query(PurchaseItem).filter_by(purchase_id=item.id) if item is not None else ()
        records, products = purchase_rows(db, data.rows, previous_rows, catalog_only=data.catalog_only)
        postings = []
        # Retain the original receipt columns as the first-row snapshot for older
        # readers; purchase_items owns the complete invoice and its row totals.
        first = {key: value for key, value in records[0].items() if key != "position"}
        if item is None:
            invoice_number = design.allocate_number(db, "purchase", settings.data["purchase_numbering"], data.purchase_date,
                                                    data.invoice_number, Purchase.invoice_number, lambda: next_purchase_number(db))
            item = Purchase(request_id=request_id, request_fingerprint=fingerprint, invoice_number=invoice_number)
            db.add(item)
            revision = 1
        else:
            old = purchase_stock(db, item)
            for product_id in old.keys() - products.keys():
                products[product_id] = require(db, Product, product_id, "کالا")
            revision = item.revision + 1
            postings.append(StockPosting(f"purchase:{item.id}:{revision}:reverse", item.purchase_date, opposite(old)))
            db.query(PurchaseItem).filter_by(purchase_id=item.id).delete(synchronize_session=False)
        item.purchase_date, item.supplier_id = data.purchase_date, data.supplier_id
        item.discount_override = override
        if "description" in data.model_fields_set:
            item.description = data.description or None
        for key, value in {**first, **{key: totals[key] for key in ("discount", "tax", "shipping")}}.items():
            setattr(item, key, value)
        db.flush()
        additions = Counter()
        for record in records:
            additions[record["product_id"]] += record["quantity"]
        postings.append(StockPosting(f"purchase:{item.id}:{revision}:apply", data.purchase_date, additions))
        post_warehouse_stock(db, products, *postings)
        items = [PurchaseItem(purchase_id=item.id, **record) for record in records]
        db.add_all(items)
        db.flush()
        remaining = totals["total"]
        for payment in data.payments:
            purchase_payments.add_payment(db, item, payment, remaining)
            remaining -= payment.amount
        if purchase_id is not None:
            item.revision = revision
            item.last_edit_id, item.last_edit_fingerprint = request_id, fingerprint
        result = purchase_data(db, item, items=items)
        presentation = snapshot.get("presentation") or design.freeze_presentation(db, "purchase", settings.data)
        item.invoice_snapshot = {**build_purchase_invoice(result, presentation, supplier, products), "finance_rules": rules}
        if previous_supplier_id == item.supplier_id and "supplier" in snapshot:
            item.invoice_snapshot = {**item.invoice_snapshot, "supplier": snapshot["supplier"]}
        db.commit()
        return result
    except IntegrityError:
        db.rollback()
        raise FinanceError("ثبت یا ویرایش خرید ممکن نشد. اطلاعات را دوباره دریافت کنید.", 409)
    except Exception:
        db.rollback()
        raise


def cancel_purchase(db, purchase_id, data, user):
    if not verify_password(data.password, user.password_hash):
        raise FinanceError("رمز حساب کاربری صحیح نیست.", 403)
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        item = require(db, Purchase, purchase_id, "خرید", include_deleted=True)
        if item.deleted_at is None:
            ensure_open(db, item.purchase_date)
            purchase_payments.void_payments(db, [tx for _, tx in purchase_payments.live_payments(db, item.id)])
            quantities = purchase_stock(db, item)
            products = {product_id: require(db, Product, product_id, "کالا") for product_id in quantities}
            post_warehouse_stock(db, products, StockPosting(f"purchase:{item.id}:cancel", item.purchase_date, opposite(quantities)))
            item.deleted_at = datetime.now(timezone.utc)
        db.commit()
        return {"id": purchase_id, "deleted": True}
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


def enabled_unit_names(db):
    return tuple(name for (name,) in enabled_units(db))


def require_enabled_unit(db, name, *, current=None, enabled=None):
    # Editing an existing record may retain its original disabled/legacy unit;
    # changing it, or creating any new record, requires an enabled catalog entry.
    if current is not None and name == normalize_text(current):
        return current
    if enabled is None:
        enabled = enabled_unit_names(db)
    if name in enabled:
        return name
    # Free-text units from older installations may use Arabic letters or extra
    # spaces. Match normalized input while retaining the catalog's original name.
    for configured in enabled:
        if name == normalize_text(configured):
            return configured
    raise FinanceError("واحد انتخاب‌شده فعال نیست. واحد را از تنظیمات ← واحد انتخاب یا فعال کنید.", 422)


def option_data(item, parent=None, product_count=0):
    data = {"id": item.id, "name": item.name, "active": item.active}
    if item.kind != "units":
        data.update(parent_id=item.parent_id,
                    path=category_path(item.name, parent.name if parent else None),
                    selectable=item.active and (parent is None or parent.active))
    if item.kind == WAREHOUSE_CATEGORIES:
        data["product_count"] = product_count
    return data


def list_options(db):
    read_snapshot(db)
    result = {"categories": [], "units": [], WAREHOUSE_CATEGORIES: []}
    items = {item.id: item for item in db.query(InventoryOption).filter(InventoryOption.deleted_at.is_(None)).order_by(InventoryOption.id)}
    counts = dict(db.query(Product.warehouse_category_id, func.count()).filter(
        Product.warehouse_category_id.is_not(None), Product.deleted_at.is_(None),
    ).group_by(Product.warehouse_category_id))
    for item in items.values():
        result[item.kind].append(option_data(item, items.get(item.parent_id), counts.get(item.id, 0)))
    return result


def save_option(db, kind, data, option_id=None):
    db.rollback()
    try:
        # Serialize settings changes with product/order writes and their validation.
        db.execute(text("BEGIN IMMEDIATE"))
        item = db.query(InventoryOption).filter_by(id=option_id, kind=kind, deleted_at=None).first() if option_id is not None else InventoryOption(kind=kind)
        if item is None:
            raise FinanceError("گزینه موردنظر پیدا نشد.", 404)
        parent = None
        if kind != "units":
            # Older PUT clients send only the name and enabled state.
            parent_id = data.parent_id if "parent_id" in data.model_fields_set else item.parent_id
            if parent_id is not None:
                parent = db.query(InventoryOption).filter_by(id=parent_id, kind=kind, parent_id=None, deleted_at=None).first()
                if parent is None or parent_id == option_id:
                    raise FinanceError("دستهٔ اصلی معتبری برای این زیردسته انتخاب کنید.", 422)
                if option_id is not None and db.query(InventoryOption.id).filter_by(parent_id=option_id, deleted_at=None).first():
                    raise FinanceError("برای تبدیل دستهٔ اصلی به زیردسته، ابتدا زیردسته‌های آن را جابه‌جا کنید.", 409)
            item.parent_id = parent_id
        elif "parent_id" in data.model_fields_set:
            raise FinanceError("واحد نمی‌تواند دستهٔ اصلی داشته باشد.", 422)
        name = data.name
        if kind == "units" and option_id is not None and name == normalize_text(item.name):
            name = item.name
        if kind == "units" and option_id is not None and item.name != name:
            if any(db.query(model.id).filter(model.unit == item.name).first() for model in (Product, OrderItem, PurchaseItem)):
                raise FinanceError("نام واحد استفاده‌شده قابل تغییر نیست. واحد جدید اضافه کنید؛ واحد قبلی را می‌توانید غیرفعال کنید.", 409)
        item.name = name
        item.active = data.active
        db.add(item)
        db.flush()
        count = db.query(Product.id).filter_by(warehouse_category_id=item.id, deleted_at=None).count() if kind == WAREHOUSE_CATEGORIES else 0
        result = option_data(item, parent, count)
        db.commit()
        return result
    except IntegrityError:
        db.rollback()
        raise FinanceError("این عنوان قبلاً ثبت شده است.", 409)
    except Exception:
        db.rollback()
        raise


def delete_category(db, category_id, kind="categories", confirm_unassignment=False):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        item = db.query(InventoryOption).filter_by(id=category_id, kind=kind, deleted_at=None).first()
        if item is None:
            raise FinanceError("دسته‌بندی موردنظر پیدا نشد.", 404)
        if db.query(InventoryOption.id).filter_by(parent_id=category_id, deleted_at=None).first():
            raise FinanceError("این دسته دارای زیردسته است. ابتدا زیردسته‌های آن را جابه‌جا یا حذف کنید.", 409)
        if kind == WAREHOUSE_CATEGORIES:
            products = db.query(Product).filter_by(warehouse_category_id=category_id)
            if not confirm_unassignment and products.filter(Product.deleted_at.is_(None)).first():
                raise FinanceError("این دسته‌بندی به کالا اختصاص دارد. حذف دسته‌بندی و برداشتن ارتباط کالاها باید تأیید شود.", 409)
            products.update({Product.warehouse_category_id: None, Product.revision: Product.revision + 1},
                            synchronize_session=False)
            # Keep the ID available to receipts and their immutable snapshots.
            item.deleted_at = datetime.now(timezone.utc)
        else:
            for model in (Product, Purchase, PurchaseItem, OrderItem):
                if db.query(model.id).filter_by(category_id=category_id).first():
                    raise FinanceError("این دسته‌بندی در کالا، خرید یا فروش استفاده شده است. می‌توانید آن را غیرفعال کنید.", 409)
            db.delete(item)
        db.commit()
        return {"id": category_id, "deleted": True}
    except Exception:
        db.rollback()
        raise
