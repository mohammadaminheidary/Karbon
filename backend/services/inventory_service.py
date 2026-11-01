from sqlalchemy.exc import IntegrityError
from sqlalchemy import text
from models.inventory import InventoryOption
from models.order import Product, OrderItem
from services.finance_service import FinanceError
from schemas.customer_schema import normalize_text


DEFAULT_UNITS = (
    "عدد", "بسته", "کیلوگرم", "گرم", "لیتر", "میلی‌لیتر", "متر",
    "سانتی‌متر", "متر مربع", "متر مکعب", "تن", "رول", "جعبه", "کارتن", "ساعت",
)


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
