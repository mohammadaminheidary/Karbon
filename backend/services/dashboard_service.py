"""Read-only reports over the existing ledger and operational tables.

Money is returned as decimal strings: totals and stock * price can exceed
JavaScript's safe integer range. No inventory history is inferred from invoices.
"""
from collections import Counter
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, text

from config import app_timezone
from models.attendance import Attendance
from models.customer import Customer
from models.document import Document, DocumentAccount
from models.finance import ExpenseCategory, FinancialTransaction as Transaction
from models.inventory import Brand, Purchase, PurchaseItem
from models.member import Member
from models.order import Order, OrderItem, Product
from models.task import Task
from services.inventory_service import category_path, with_category_names
from services.finance_service import bank_list
from services.fiscal_period import active_period, effective_day, in_active_period
from services.receivables import active_bounds, invoice_positions


def debt_rows(db, today):
    _, end = active_bounds()
    balances = invoice_positions(end).c
    return db.query(balances.customer_id, func.sum(balances.remaining),
                    func.sum(case((balances.payment_date < today, balances.remaining), else_=0))
                    ).group_by(balances.customer_id).all()


def debtor_list(rows, names):
    return sorted((dict(id=key, name=names[key], amount=str(int(amount)))
                   for key, amount, _ in rows if amount > 0 and key in names),
                  key=lambda row: (-int(row["amount"]), row["id"]))


def product_sales_rows(db, start, end):
    # Item gross sales exclude invoice-wide discounts: no invented allocation.
    gross_sales = func.sum(OrderItem.quantity * OrderItem.unit_price)
    rows = db.query(
        OrderItem.product_id, OrderItem.product_name, OrderItem.unit, Brand.name,
        func.sum(OrderItem.quantity), gross_sales,
    ).join(Order, Order.id == OrderItem.order_id).join(Product, Product.id == OrderItem.product_id).outerjoin(
        Brand, Brand.id == Product.brand_id,
    ).filter(Order.deleted_at.is_(None), Order.invoice_date.between(start, end), in_active_period(Order.invoice_date)).group_by(
        OrderItem.product_id, OrderItem.product_name, OrderItem.unit, Brand.name,
    ).order_by(gross_sales.desc())
    return [dict(id=pid, name=name, unit=unit, brand_name=brand_name, quantity=int(quantity), gross=str(int(gross)))
            for pid, name, unit, brand_name, quantity, gross in rows]


def dashboard(db, start, end, view="full", include_debtors=False, include_products=False):
    # sqlite3's legacy transaction mode does not BEGIN on SELECT. Explicitly
    # start a read transaction so every section describes the same snapshot.
    db.rollback()
    db.execute(text("BEGIN"))
    zone = app_timezone()
    now = datetime.now(zone)
    fiscal = active_period(db)
    business_date = effective_day(fiscal, now.date())
    if view == "debtors":
        names = {cid: f"{first} {last}" for cid, first, last in db.query(
            Customer.id, Customer.first_name, Customer.last_name,
        ).filter(Customer.deleted_at.is_(None)).all()}
        return {"customers": {"debtors": debtor_list(debt_rows(db, business_date), names)}}
    if view == "products":
        return {"product_sales": product_sales_rows(db, start, end)}
    include_debtors = include_debtors or view == "full"
    include_products = include_products or view == "full"
    days = (end - start).days + 1
    previous_start = start - timedelta(days=days)
    previous_end = start - timedelta(days=1)
    daily = {}
    for index in range(days):
        day = start + timedelta(days=index)
        daily[day] = dict(date=day.isoformat(), income=0, expense=0, transactions=0,
                         orders=0, sales=0, customers=0, documents=0,
                         tasks=0, tasks_completed=0, present=0, absent=0)

    finance = dict(income=0, expense=0, transactions=0)
    previous = dict(income=0, expense=0, transactions=0, orders=0, sales=0, customers=0, documents=0, tasks=0, tasks_completed=0, present=0, absent=0)
    rows = db.query(Transaction.transaction_date, Transaction.kind, func.sum(Transaction.amount), func.count(Transaction.id)).filter(
        Transaction.deleted_at.is_(None), Transaction.transaction_date.between(previous_start, end), in_active_period(Transaction.transaction_date),
    ).group_by(Transaction.transaction_date, Transaction.kind).all()
    for day, kind, amount, count in rows:
        target = finance if day >= start else previous
        target[kind] += int(amount)
        target["transactions"] += count
        if day in daily:
            daily[day][kind] = int(amount)
            daily[day]["transactions"] += count
    finance["net"] = finance["income"] - finance["expense"]
    previous["net"] = previous["income"] - previous["expense"]

    orders_query = db.query(Order).filter(Order.deleted_at.is_(None), in_active_period(Order.invoice_date))
    order_counts = dict(orders_query.with_entities(Order.status, func.count(Order.id)).group_by(Order.status).all())
    order_summary = dict(count=0, sales=0, discount=0, active=0, completed=0)
    for day, status, count, total, discount in orders_query.with_entities(
        Order.invoice_date, Order.status, func.count(Order.id), func.sum(Order.total), func.sum(Order.discount),
    ).filter(Order.invoice_date.between(previous_start, end)).group_by(Order.invoice_date, Order.status).all():
        if day >= start:
            order_summary["count"] += count
            order_summary["sales"] += int(total)
            order_summary["discount"] += int(discount)
            order_summary[status] += count
            daily[day]["orders"] += count
            daily[day]["sales"] += int(total)
        else:
            previous["orders"] += count
            previous["sales"] += int(total)

    debts_by_customer = debt_rows(db, business_date)
    debts = {customer_id: amount for customer_id, amount, _ in debts_by_customer}
    outstanding = sum(int(value) for value in debts.values())
    overdue = sum(int(value or 0) for _, _, value in debts_by_customer)

    customer_columns = (Customer.id, Customer.first_name, Customer.last_name, Customer.created_at) if include_debtors else (Customer.id, Customer.created_at)
    customers = db.query(*customer_columns).filter(Customer.deleted_at.is_(None)).all()
    new_customers = 0
    for customer in customers:
        created = customer.created_at
        day = created.replace(tzinfo=created.tzinfo or timezone.utc).astimezone(zone).date()
        if day in daily:
            daily[day]["customers"] += 1
            new_customers += 1
        elif previous_start <= day <= previous_end:
            previous["customers"] += 1
    customer_ids = {row.id for row in customers}
    debtor_count = sum(amount > 0 and cid in customer_ids for cid, amount in debts.items())
    customer_summary = dict(total=len(customers), new=new_customers, debtor_count=debtor_count)
    if include_debtors:
        customer_summary["debtors"] = debtor_list(debts_by_customer, {row.id: f"{row.first_name} {row.last_name}" for row in customers})

    products = with_category_names(
        db.query(Product.id, Product.name, Product.unit, Product.price, Product.stock, Product.active, Product.category_id)
        .filter(Product.deleted_at.is_(None)), Product.category_id,
    ).outerjoin(Brand, Brand.id == Product.brand_id).add_columns(Brand.name.label("brand_name")).all()
    inventory = [dict(id=p.id, name=p.name, unit=p.unit, price=str(p.price), stock=p.stock,
                      category_id=p.category_id, category_path=category_path(p.category_name, p.category_parent_name),
                      brand_name=p.brand_name, active=p.active, value=str(p.price * p.stock)) for p in products if p.stock is not None]
    inventory.sort(key=lambda row: (-int(row["value"]), row["id"]))

    banks = [dict(id=bank["id"], name=bank["name"], active=bank["active"],
                  balance=str(bank["balance"]), opening_balance=str(bank["opening_balance"]))
             for bank in bank_list(db)]
    purchase_lines = db.query(PurchaseItem.purchase_id.label("id"),
        func.sum(PurchaseItem.quantity * PurchaseItem.purchase_price).label("subtotal")
    ).group_by(PurchaseItem.purchase_id).subquery()
    purchase_count, purchase_value = db.query(func.count(Purchase.id), func.coalesce(func.sum(
        purchase_lines.c.subtotal - Purchase.discount + Purchase.tax + Purchase.shipping), 0)
    ).join(purchase_lines, purchase_lines.c.id == Purchase.id).filter(
        Purchase.deleted_at.is_(None), Purchase.purchase_date.between(start, end), in_active_period(Purchase.purchase_date)).one()

    expenses = [dict(name=name, amount=str(int(amount)), count=count) for name, amount, count in db.query(
        func.coalesce(ExpenseCategory.title, DocumentAccount.title, Transaction.title).label("source"),
        func.sum(Transaction.amount), func.count(Transaction.id),
    ).outerjoin(ExpenseCategory, ExpenseCategory.id == Transaction.expense_category_id).outerjoin(
        DocumentAccount, DocumentAccount.id == Transaction.document_account_id,
    ).filter(Transaction.deleted_at.is_(None), Transaction.kind == "expense", Transaction.transaction_date.between(start, end),
             in_active_period(Transaction.transaction_date)).group_by(
        Transaction.expense_category_id, Transaction.document_account_id, text("source"),
    ).order_by(func.sum(Transaction.amount).desc()).all()]

    task_counts = Counter()
    for day, status, count in db.query(Task.date, Task.status, func.count(Task.id)).filter(Task.date.between(previous_start, end)).group_by(Task.date, Task.status).all():
        target = daily.get(day, previous)
        target["tasks"] += count
        if status == "completed":
            target["tasks_completed"] += count
        if day >= start:
            task_counts[status] += count
    overdue_tasks = db.query(Task.id).filter(Task.date < now.date(), Task.status != "completed").count()

    attendance_counts = Counter()
    for day, status, count in db.query(Attendance.date, Attendance.status, func.count(Attendance.id)).filter(
        Attendance.date.between(previous_start, end),
    ).group_by(Attendance.date, Attendance.status).all():
        daily.get(day, previous)[status] += count
        if day >= start:
            attendance_counts[status] += count
    today_presence = db.query(Attendance.id).filter(Attendance.date == now.date(), Attendance.status == "present").count()

    document_types = Counter()
    for day, kind, count in db.query(Document.date, Document.document_type, func.count(Document.id)).filter(
        Document.deleted_at.is_(None), Document.date.between(previous_start, end), in_active_period(Document.date),
    ).group_by(Document.date, Document.document_type).all():
        daily.get(day, previous)["documents"] += count
        if day >= start:
            document_types[kind] += count

    for point in daily.values():
        for key in ("income", "expense", "sales"):
            point[key] = str(point[key])
    for values in (finance, previous, order_summary):
        for key in ("income", "expense", "net", "sales", "discount"):
            if key in values:
                values[key] = str(values[key])
    return dict(
        generated_at=now.isoformat(), today=business_date.isoformat(), timezone=zone.key, currency="تومان",
        fiscal_year=fiscal.year if fiscal else None,
        period=dict(start=start.isoformat(), end=end.isoformat(), days=days,
                    previous_start=previous_start.isoformat(), previous_end=previous_end.isoformat()),
        finance=finance, previous=previous, daily=list(daily.values()), expenses=expenses,
        orders={**order_summary, "total": sum(order_counts.values()), "active_total": order_counts.get("active", 0),
                "outstanding": str(outstanding), "overdue": str(overdue)},
        customers=customer_summary,
        inventory=dict(value=str(sum(int(row["value"]) for row in inventory)), products=inventory,
                       tracked=len(inventory), services=sum(p.stock is None for p in products),
                       out_of_stock=sum(row["stock"] <= 0 and row["active"] for row in inventory)),
        banks=dict(items=banks, balance=str(sum(int(row["balance"]) for row in banks)),
                   opening_balance=str(sum(int(row["opening_balance"]) for row in banks))),
        purchases=dict(count=purchase_count, value=str(purchase_value)),
        **({"product_sales": product_sales_rows(db, start, end)} if include_products else {}),
        tasks=dict(total=sum(task_counts.values()), todo=task_counts["todo"], in_progress=task_counts["in_progress"],
                   completed=task_counts["completed"], overdue=overdue_tasks),
        attendance=dict(members=db.query(Member.id).count(), present=attendance_counts["present"],
                        absent=attendance_counts["absent"], today_present=today_presence),
        documents=dict(total=sum(document_types.values()), types=[dict(name=key, count=value) for key, value in document_types.most_common()]),
    )
