from datetime import date

from sqlalchemy import String, case, cast, exists, func, insert, or_, select, text
from sqlalchemy.orm import object_session

from models.customer import Customer, utc_now
from models.finance import FinancialTransaction
from models.fiscal_year import FiscalYear
from models.order import Order, OrderPayment
from services.customer_ids import generate_customer_id, generate_customer_ids
from services.fiscal_period import active_value, in_active_period
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


class CustomerHasOrders(Exception):
    pass


def invoice_balances(db, customer_id=None):
    # Receipts on older invoices are active-year cash. Only active-year
    # invoices contribute sales, and only payments through the period end
    # contribute to outstanding balances.
    end = func.coalesce(active_value(FiscalYear.end_date).scalar_subquery(), date.max)
    tx = FinancialTransaction
    payments = db.query(
        OrderPayment.order_id.label("order_id"),
        func.sum(tx.amount).label("paid_through_end"),
        func.sum(case((in_active_period(tx.transaction_date), tx.amount), else_=0)).label("paid"),
    ).join(tx, tx.id == OrderPayment.transaction_id).filter(
        tx.deleted_at.is_(None), tx.transaction_date <= end,
    )
    if customer_id is not None:
        payments = payments.filter(OrderPayment.order_id.in_(select(Order.id).where(Order.customer_id == customer_id)))
    allocations = payments.group_by(OrderPayment.order_id).subquery()
    invoice_total = Order.subtotal - Order.discount
    in_period = in_active_period(Order.invoice_date)
    through_end = Order.invoice_date <= end
    unpaid = func.max(invoice_total - func.coalesce(allocations.c.paid_through_end, 0), 0)
    query = db.query(
        Order.customer_id.label("customer_id"),
        func.sum(case((in_period, 1), else_=0)).label("order_count"),
        func.sum(case((in_period, invoice_total), else_=0)).label("sales"),
        func.sum(allocations.c.paid).label("paid"),
        func.sum(case((through_end, unpaid), else_=0)).label("debt"),
        func.sum(case((through_end, 1), else_=0)).label("invoices"),
    ).outerjoin(allocations, allocations.c.order_id == Order.id).filter(
        Order.deleted_at.is_(None),
    )
    if customer_id is not None:
        query = query.filter(Order.customer_id == customer_id)
    return query.group_by(Order.customer_id)


def customer_summary(count=0, sales=0, paid=0, debt=0, invoices=0):
    return CustomerSummary(order_count=int(count or 0), total_orders=int(sales or 0),
                           paid=int(paid or 0), debt=int(debt or 0), available=True,
                           status="debtor" if debt else "settled" if invoices else "no_payment")


def get_summary(db, customer_id):
    row = invoice_balances(db, customer_id).one_or_none()
    return customer_summary(*row[1:]) if row else customer_summary()


def serialize_customer(customer, summary=None):
    return {
        **{column.name: getattr(customer, column.name) for column in Customer.__table__.columns},
        "summary": summary if summary is not None else get_summary(object_session(customer), customer.id),
    }


def get_customer(db, customer_id):
    customer = db.get(Customer, customer_id)
    if customer is None or customer.deleted_at is not None:
        raise CustomerNotFound()
    return customer


def phone_values():
    return func.json_each(Customer.phone_numbers).table_valued("value")


def list_customers(db, search="", skip=0, limit=50, *, options_only=False, customer_id=None):
    query = db.query(Customer).filter(Customer.deleted_at.is_(None))
    if customer_id is not None:
        query = query.filter(Customer.id == customer_id)
    if not options_only:
        balances = invoice_balances(db).subquery()
        counts = query.outerjoin(balances, balances.c.customer_id == Customer.id).with_entities(
            func.count(Customer.id),
            func.coalesce(func.sum(case((balances.c.debt > 0, 1), else_=0)), 0),
            func.coalesce(func.sum(case(((balances.c.debt == 0) & (balances.c.invoices > 0), 1), else_=0)), 0),
        ).one()
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
            func.lower(Customer.permanent_id).like(pattern, escape="\\"),
            func.lower(Customer.first_name + " " + Customer.last_name).like(pattern, escape="\\"),
            exists(select(1).select_from(phones).where(phones.c.value.like(phone_pattern, escape="\\"))),
        ))
    total = query.count()
    if options_only:
        fields = (Customer.id, Customer.customer_code, Customer.first_name, Customer.last_name, Customer.phone_numbers)
        items = query.with_entities(*fields).order_by(Customer.id.desc()).offset(skip).limit(limit).all()
        return {"items": [dict(row._mapping) for row in items], "total": total, "skip": skip, "limit": limit}
    items = query.outerjoin(balances, balances.c.customer_id == Customer.id).add_columns(
        balances.c.order_count, balances.c.sales, balances.c.paid, balances.c.debt, balances.c.invoices,
    ).order_by(Customer.id.desc()).offset(skip).limit(limit).all()
    serialized = [serialize_customer(item, customer_summary(*values)) for item, *values in items]
    return {"items": serialized, "total": total, "skip": skip, "limit": limit,
            "total_customers": counts[0], "unsettled_customers": counts[1], "settled_customers": counts[2]}


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


def customer_import_conflicts(db, rows):
    names = {(row.first_name.lower(), row.last_name.lower()) for row in rows}
    phones = {phone for row in rows for phone in row.phone_numbers}
    existing_names, existing_phones = set(), set()
    if names:
        records = db.execute(select(Customer.first_name, Customer.last_name, Customer.phone_numbers)
                             .where(Customer.deleted_at.is_(None)).execution_options(yield_per=500))
        for first, last, numbers in records:
            name = (first.lower(), last.lower())
            if name in names:
                existing_names.add(name)
            existing_phones.update(phones.intersection(numbers or ()))
    return existing_names, existing_phones


def insert_customers(db, rows):
    """Insert validated customers while the caller holds the customer write lock."""
    if not rows:
        return
    first_code = next_code(db)
    registered_at = utc_now()
    permanent_ids = generate_customer_ids(db.connection(), registered_at, len(rows))
    db.execute(insert(Customer), [
        dict(row.model_dump(exclude={"confirm_duplicate"}),
             customer_code=first_code + offset, created_at=registered_at, permanent_id=permanent_id)
        for offset, (row, permanent_id) in enumerate(zip(rows, permanent_ids))
    ], execution_options={"render_nulls": True})


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
            registered_at = utc_now()
            customer = Customer(customer_code=next_code(db), created_at=registered_at,
                                permanent_id=generate_customer_id(db.connection(), registered_at), **values)
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
        if db.query(Order.id).filter(Order.customer_id == customer_id, Order.deleted_at.is_(None)).first():
            raise CustomerHasOrders()
        linked = db.query(FinancialTransaction).filter(FinancialTransaction.customer_id == customer_id)
        remaining = linked.filter(FinancialTransaction.deleted_at.is_(None)).count()
        if remaining:
            raise CustomerHasTransactions(remaining)
        if linked.first() or db.query(Order.id).filter(Order.customer_id == customer_id).first():
            # Retain foreign keys and retry IDs of deleted receipts/invoices.
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
