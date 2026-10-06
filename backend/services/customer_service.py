from sqlalchemy import String, cast, exists, func, or_, select, text

from models.customer import Customer, utc_now
from models.finance import FinancialTransaction
from services.reference_codes import compact_customer_codes
from schemas.customer_schema import CustomerSummary, normalize_text


class DuplicateCustomers(Exception):
    def __init__(self, matches):
        self.matches = matches


class CustomerNotFound(Exception):
    pass


class CustomerHasTransactions(Exception):
    def __init__(self, count):
        self.count = count


def get_summary(customer_id):
    """Aggregation boundary for future orders/payment services.

    Those tables do not exist yet. Zero totals represent no recorded activity,
    and `available=False` lets the UI explain that financial data is unavailable.
    Never persist financial totals or status in customers.
    """
    summary = CustomerSummary()
    summary.debt = summary.total_orders - summary.paid
    summary.status = (
        "debtor" if summary.debt > 0 else
        "settled" if summary.paid > 0 else "no_payment"
    )
    return summary


def serialize_customer(customer):
    return {
        **{column.name: getattr(customer, column.name) for column in Customer.__table__.columns},
        "summary": get_summary(customer.id),
    }


def get_customer(db, customer_id):
    customer = db.get(Customer, customer_id)
    if customer is None or customer.deleted_at is not None:
        raise CustomerNotFound()
    return customer


def phone_values():
    return func.json_each(Customer.phone_numbers).table_valued("value")


def list_customers(db, search="", skip=0, limit=50):
    query = db.query(Customer).filter(Customer.deleted_at.is_(None))
    search = normalize_text(search).lower()
    if search:
        # Escape LIKE wildcards so searches are literal and parameterized.
        pattern = "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        phones = phone_values()
        phone_pattern = pattern.replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
        if phone_pattern.startswith("%+98"):
            phone_pattern = "%0" + phone_pattern[4:]
        if phone_pattern.startswith("%0098"):
            phone_pattern = "%0" + phone_pattern[5:]
        query = query.filter(or_(
            cast(Customer.customer_code, String).like(pattern, escape="\\"),
            func.lower(Customer.first_name + " " + Customer.last_name).like(pattern, escape="\\"),
            exists(select(1).select_from(phones).where(phones.c.value.like(phone_pattern, escape="\\"))),
        ))
    total = query.count()
    items = query.order_by(Customer.id.desc()).offset(skip).limit(limit).all()
    return {"items": [serialize_customer(item) for item in items], "total": total, "skip": skip, "limit": limit}


def next_code(db):
    return 1001 + db.query(Customer).filter(Customer.deleted_at.is_(None)).count()


def find_duplicates(db, data, exclude_id=None):
    same_name = (func.lower(Customer.first_name) == data.first_name.lower()) & (func.lower(Customer.last_name) == data.last_name.lower())
    filters = [same_name]
    if data.phone_numbers:
        phones = phone_values()
        filters.append(exists(select(1).select_from(phones).where(phones.c.value.in_(data.phone_numbers))))
    query = db.query(Customer).filter(Customer.deleted_at.is_(None), or_(*filters))
    if exclude_id is not None:
        query = query.filter(Customer.id != exclude_id)
    matches = []
    for customer in query.order_by(Customer.id).limit(20).all():
        matches.append({
            "id": customer.id,
            "customer_code": customer.customer_code,
            "first_name": customer.first_name,
            "last_name": customer.last_name,
            "name_match": (customer.first_name.lower(), customer.last_name.lower()) == (data.first_name.lower(), data.last_name.lower()),
            "matching_phones": [phone for phone in customer.phone_numbers if phone in data.phone_numbers],
        })
    return matches


def save_customer(db, data, customer_id=None):
    # SQLite reserves the write lock BEFORE allocating the code or checking
    # duplicates, preventing concurrent requests from racing either operation.
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        customer = get_customer(db, customer_id) if customer_id is not None else None
        matches = find_duplicates(db, data, exclude_id=customer_id)
        if matches and not data.confirm_duplicate:
            raise DuplicateCustomers(matches)
        values = data.model_dump(exclude={"confirm_duplicate"})
        if customer is None:
            customer = Customer(customer_code=next_code(db), **values)
            db.add(customer)
        else:
            for key, value in values.items():
                setattr(customer, key, value)
        db.flush()
        result = serialize_customer(customer)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def delete_customer(db, customer_id):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        customer = get_customer(db, customer_id)
        linked = db.query(FinancialTransaction).filter(FinancialTransaction.customer_id == customer_id)
        remaining = linked.filter(FinancialTransaction.deleted_at.is_(None)).count()
        if remaining:
            raise CustomerHasTransactions(remaining)
        if linked.first():
            # Retain the foreign key and retry UUIDs of deleted financial rows.
            customer.deleted_at = utc_now()
            customer.updated_at = customer.deleted_at
            customer.customer_code = -customer.id
        else:
            db.delete(customer)
        db.flush()
        compact_customer_codes(db)
        db.expire_all()
        db.commit()
    except Exception:
        db.rollback()
        raise
