from sqlalchemy.exc import IntegrityError
from models.inventory import InventoryOption
from services.finance_service import FinanceError


def option_data(item):
    return {"id": item.id, "name": item.name, "active": item.active}


def list_options(db):
    result = {"categories": [], "units": []}
    for item in db.query(InventoryOption).order_by(InventoryOption.id).all():
        result[item.kind].append(option_data(item))
    return result


def save_option(db, kind, data, option_id=None):
    try:
        item = db.query(InventoryOption).filter_by(id=option_id, kind=kind).first() if option_id is not None else InventoryOption(kind=kind)
        if item is None:
            raise FinanceError("گزینه موردنظر پیدا نشد.", 404)
        item.name = data.name
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
