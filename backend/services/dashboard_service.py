"""Read-only reports over the existing ledger and operational tables.

Money is returned as decimal strings: totals and stock * price can exceed
JavaScript's safe integer range. No inventory history is inferred from invoices.
"""
from collections import Counter
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, text

from config import APP_TIMEZONE, APP_TIMEZONE_NAME
from models.attendance import Attendance
from models.customer import Customer
from models.document import Document, DocumentAccount
from models.finance import BankAccount, BankDirectory, ExpenseCategory, FinancialTransaction as Transaction
from models.member import Member
from models.order import Order, OrderItem, OrderPayment, Product
from models.task import Task


def dashboard(db, start, end):
    # sqlite3's legacy transaction mode does not BEGIN on SELECT. Explicitly
    # start a read transaction so every section describes the same snapshot.
    db.rollback()
    db.execute(text("BEGIN"))
    now = datetime.now(APP_TIMEZONE)
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
        Transaction.deleted_at.is_(None), Transaction.transaction_date.between(previous_start, end),
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

    orders_query = db.query(Order).filter(Order.deleted_at.is_(None))
    order_counts = dict(orders_query.with_entities(Order.status, func.count(Order.id)).group_by(Order.status).all())
    order_summary = dict(count=0, sales=0, discount=0, active=0, completed=0)
    for day, status, count, total, discount in orders_query.with_entities(
        Order.invoice_date, Order.status, func.count(Order.id), func.sum(Order.subtotal - Order.discount), func.sum(Order.discount),
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

    paid = db.query(OrderPayment.order_id.label("order_id"), func.sum(Transaction.amount).label("paid")).join(
        Transaction, Transaction.id == OrderPayment.transaction_id,
    ).filter(Transaction.deleted_at.is_(None)).group_by(OrderPayment.order_id).subquery()
    remaining = case((Order.subtotal - Order.discount - func.coalesce(paid.c.paid, 0) > 0,
                      Order.subtotal - Order.discount - func.coalesce(paid.c.paid, 0)), else_=0)
    debts = dict(db.query(Order.customer_id, func.sum(remaining)).outerjoin(paid, paid.c.order_id == Order.id).filter(
        Order.deleted_at.is_(None),
    ).group_by(Order.customer_id).all())
    outstanding = sum(int(value) for value in debts.values())
    overdue = int(db.query(func.coalesce(func.sum(remaining), 0)).select_from(Order).outerjoin(
        paid, paid.c.order_id == Order.id,
    ).filter(Order.deleted_at.is_(None), Order.payment_date < now.date()).scalar())

    customers = db.query(Customer.id, Customer.first_name, Customer.last_name, Customer.created_at).filter(Customer.deleted_at.is_(None)).all()
    new_customers = 0
    for customer in customers:
        created = customer.created_at
        day = created.replace(tzinfo=created.tzinfo or timezone.utc).astimezone(APP_TIMEZONE).date()
        if day in daily:
            daily[day]["customers"] += 1
            new_customers += 1
        elif previous_start <= day <= previous_end:
            previous["customers"] += 1
    customer_names = {row.id: f"{row.first_name} {row.last_name}" for row in customers}
    debtors = sorted((dict(id=key, name=customer_names[key], amount=str(int(value)))
                      for key, value in debts.items() if value > 0 and key in customer_names),
                     key=lambda row: (-int(row["amount"]), row["id"]))

    products = db.query(Product.id, Product.name, Product.unit, Product.price, Product.stock, Product.active).filter(Product.deleted_at.is_(None)).all()
    inventory = [dict(id=p.id, name=p.name, unit=p.unit, price=str(p.price), stock=p.stock,
                      active=p.active, value=str(p.price * p.stock)) for p in products if p.stock is not None]
    inventory.sort(key=lambda row: (-int(row["value"]), row["id"]))

    ledger_totals = db.query(Transaction.bank_id.label("bank_id"), func.sum(case(
        (Transaction.kind == "income", Transaction.amount), else_=-Transaction.amount,
    )).label("net")).filter(Transaction.deleted_at.is_(None)).group_by(Transaction.bank_id).subquery()
    banks = [dict(id=bank.id, name=name or bank.name, active=bank.active,
                  balance=str(bank.opening_balance + int(net or 0)))
             for bank, name, net in db.query(BankAccount, BankDirectory.name, ledger_totals.c.net).outerjoin(
                 BankDirectory, BankDirectory.code == BankAccount.bank,
             ).outerjoin(ledger_totals, ledger_totals.c.bank_id == BankAccount.id).filter(BankAccount.deleted_at.is_(None)).order_by(BankAccount.id).all()]

    expenses = [dict(name=name, amount=str(int(amount)), count=count) for name, amount, count in db.query(
        func.coalesce(ExpenseCategory.title, DocumentAccount.title, Transaction.title).label("source"),
        func.sum(Transaction.amount), func.count(Transaction.id),
    ).outerjoin(ExpenseCategory, ExpenseCategory.id == Transaction.expense_category_id).outerjoin(
        DocumentAccount, DocumentAccount.id == Transaction.document_account_id,
    ).filter(Transaction.deleted_at.is_(None), Transaction.kind == "expense", Transaction.transaction_date.between(start, end)).group_by(
        Transaction.expense_category_id, Transaction.document_account_id, text("source"),
    ).order_by(func.sum(Transaction.amount).desc()).all()]

    # Item gross sales deliberately exclude invoice-wide discounts, which cannot
    # be allocated to individual products without inventing an allocation rule.
    product_sales = [dict(id=pid, name=name, unit=unit, quantity=int(quantity), gross=str(int(gross)))
                     for pid, name, unit, quantity, gross in db.query(
                         OrderItem.product_id, OrderItem.product_name, OrderItem.unit, func.sum(OrderItem.quantity),
                         func.sum(OrderItem.quantity * OrderItem.unit_price),
                     ).join(Order, Order.id == OrderItem.order_id).filter(Order.deleted_at.is_(None), Order.invoice_date.between(start, end)).group_by(
                         OrderItem.product_id, OrderItem.product_name, OrderItem.unit,
                     ).order_by(func.sum(OrderItem.quantity * OrderItem.unit_price).desc()).all()]

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
        Document.deleted_at.is_(None), Document.date.between(previous_start, end),
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
        generated_at=now.isoformat(), today=now.date().isoformat(), timezone=APP_TIMEZONE_NAME, currency="تومان",
        period=dict(start=start.isoformat(), end=end.isoformat(), days=days,
                    previous_start=previous_start.isoformat(), previous_end=previous_end.isoformat()),
        finance=finance, previous=previous, daily=list(daily.values()), expenses=expenses,
        orders={**order_summary, "total": sum(order_counts.values()), "active_total": order_counts.get("active", 0),
                "outstanding": str(outstanding), "overdue": str(overdue)},
        customers=dict(total=len(customers), new=new_customers, debtor_count=len(debtors), debtors=debtors),
        inventory=dict(value=str(sum(int(row["value"]) for row in inventory)), products=inventory,
                       tracked=len(inventory), services=sum(p.stock is None for p in products),
                       out_of_stock=sum(row["stock"] == 0 and row["active"] for row in inventory)),
        banks=dict(items=banks, balance=str(sum(int(row["balance"]) for row in banks))),
        product_sales=product_sales,
        tasks=dict(total=sum(task_counts.values()), todo=task_counts["todo"], in_progress=task_counts["in_progress"],
                   completed=task_counts["completed"], overdue=overdue_tasks),
        attendance=dict(members=db.query(Member.id).count(), present=attendance_counts["present"],
                        absent=attendance_counts["absent"], today_present=today_presence),
        documents=dict(total=sum(document_types.values()), types=[dict(name=key, count=value) for key, value in document_types.most_common()]),
    )
