"""Build a single cutoff dataset for the preview, archive and all downloads."""
from collections import Counter, defaultdict
from datetime import date, timedelta, timezone

import jdatetime
from fastapi.encoders import jsonable_encoder
from sqlalchemy import or_, select
from sqlalchemy.orm import defer, undefer

from config import app_timezone
from models.customer import Customer
from models.document import Document, DocumentAccount
from models.finance import BankAccount, BankDirectory, ExpenseCategory, FinancialTransaction as Tx
from models.fiscal_year import FiscalInventoryOpening, InventoryChange, InventoryHistory
from models.inventory import InventoryOption, Purchase, PurchaseItem, PurchasePayment
from models.order import CASH_ACCOUNT_NUMBER, Order, OrderItem, OrderPayment, Product
from services.fiscal_period import bank_openings, jalali, year_dates, year_of
from services.inventory_service import PURCHASE_INTERNAL_FIELDS
from services import purchase_payments
from services.receivables import CUSTOMER_RECEIPT_METHOD, general_allocations, invoice_positions


MONTHS = ("فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
          "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند")
METHODS = {"pos": "کارت‌خوان", "cash": "نقدی", "transfer": "کارت‌به‌کارت", "unknown": "ثبت نشده",
           CUSTOMER_RECEIPT_METHOD: "دریافت از مشتری"}


def columns(row, omit=()):
    return {column.name: getattr(row, column.name) for column in row.__table__.columns if column.name not in omit}


def local_date(stamp, zone):
    return stamp.replace(tzinfo=stamp.tzinfo or timezone.utc).astimezone(zone).date()


def inventory_at(db, cutoff):
    history = db.get(InventoryHistory, 1)
    if history is None or cutoff < history.available_from:
        since = f" از {jalali(history.available_from)}" if history else ""
        return {"available": False, "reason": f"سوابق قابل بازسازی موجودی{since} آغاز می‌شود.", "rows": []}
    totals = Counter()
    tracked = {}
    quantities = Counter()
    states = {}
    for change in db.scalars(select(InventoryChange).where(InventoryChange.scope == "sales")
                             .order_by(InventoryChange.business_date, InventoryChange.id)):
        totals[change.product_id] += change.delta
        if change.tracked is not None and (change.product_id not in tracked or tracked[change.product_id].id < change.id):
            tracked[change.product_id] = change
        if change.business_date <= cutoff:
            quantities[change.product_id] += change.delta
            saved = states.get(change.product_id)
            if change.tracked is not None and (saved is None or
                    (max(change.business_date, history.available_from), change.id) >
                    (max(saved.business_date, history.available_from), saved.id)):
                states[change.product_id] = change
    live = {pid: qty for pid, qty in db.execute(select(Product.id, Product.stock).where(
        Product.deleted_at.is_(None), Product.catalog == "sales", Product.stock.is_not(None)))}
    expected = {pid: totals[pid] for pid, change in tracked.items() if change.tracked}
    if expected != live:
        return {"available": False, "reason": "سوابق تغییر موجودی برای بازسازی مانده در تاریخ پایان سال کافی نیست.", "rows": []}
    return {"available": True, "reason": None, "rows": [
        {"product_id": pid, "product_code": state.product_code, "name": state.name,
         "unit": state.unit, "quantity": quantities[pid]}
        for pid, state in sorted(states.items()) if state.tracked
    ]}


def customer_positions(orders, positions, receipts, credits, cutoff):
    invoices = {}
    accounts = defaultdict(lambda: {"receivable": 0, "credit": 0})
    for tx in credits:
        if tx.transaction_date <= cutoff:
            accounts[tx.customer_id]["credit"] += tx.amount
    for order in orders:
        position = positions.get(order.id)
        if position is None:
            paid = sum(tx.amount for _, tx in receipts[order.id] if tx.transaction_date <= cutoff)
            if paid:
                accounts[order.customer_id]["credit"] += paid
            continue
        amount = position.remaining
        if position.general_paid or position.direct_paid > position.total:
            accounts[order.customer_id]["credit"] += max(position.direct_paid - position.total, 0) - position.general_paid
        if amount:
            accounts[order.customer_id]["receivable"] += amount
            invoices[order.id] = {
                "order_id": order.id, "customer_id": order.customer_id, "source_year": year_of(order.invoice_date),
                "paid": position.paid, "amount": amount, "overdue": order.payment_date < cutoff,
            }
    return invoices, [{"customer_id": cid, **values} for cid, values in sorted(accounts.items())
                      if values["receivable"] or values["credit"]]


def account_balances(db, year, start, cutoff, zone, transactions):
    opening = bank_openings(db, year)
    prior = Counter()
    activity = defaultdict(Counter)
    for tx in transactions:
        if tx.transaction_date < start:
            prior[tx.bank_id] += tx.amount if tx.kind == "income" else -tx.amount
        else:
            activity[tx.bank_id][tx.kind] += tx.amount
    accounts = []
    for account, bank_name in db.execute(select(BankAccount, BankDirectory.name).outerjoin(
        BankDirectory, BankDirectory.code == BankAccount.bank).order_by(BankAccount.id)
    ):
        cash = account.account_number == CASH_ACCOUNT_NUMBER
        if not cash and account.id not in opening and account.id not in activity and account.id not in prior:
            if ((account.created_at and local_date(account.created_at, zone) > cutoff)
                    or (account.deleted_at and local_date(account.deleted_at, zone) <= cutoff)):
                continue
        initial = opening.get(account.id, account.opening_balance + prior[account.id])
        income, expense = activity[account.id]["income"], activity[account.id]["expense"]
        accounts.append({
            **columns(account, {"opening_balance"}), "bank_name": bank_name, "is_cash": cash,
            "opening_balance": initial, "income": income, "expense": expense,
            "closing_balance": initial + income - expense,
        })
    if not any(account["is_cash"] for account in accounts):
        accounts.append({"id": None, "name": "صندوق نقدی", "account_number": CASH_ACCOUNT_NUMBER,
                         "is_cash": True, "opening_balance": 0, "income": 0, "expense": 0, "closing_balance": 0})
    return accounts


def summarize(data):
    customers = data["customers"]
    orders = [o for o in data["orders"] if o["in_period"]]
    transactions = [t for t in data["transactions"] if t["in_period"]]
    purchases = data["purchases"]
    distinct_orderers = {o["customer_id"] for o in orders}
    closing = data["closing_customer_accounts"]
    open_invoices = data["closing_invoices"]
    opening_debtors = {row["customer_id"] for row in data["opening_customer_accounts"] if row["receivable"]}
    debtors = {row["customer_id"] for row in closing if row["receivable"]}
    settled = (distinct_orderers | opening_debtors) - debtors
    return {
        "customers": sum(c["at_year_end"] for c in customers),
        "new_customers": sum(c["new_in_period"] for c in customers),
        "ordering_customers": len(distinct_orderers), "settled_customers": len(settled),
        "carryover_customers": len(closing), "open_invoices": len(open_invoices),
        "receivables": sum(acct["receivable"] for acct in closing),
        "credits": sum(acct["credit"] for acct in closing),
        "overdue": sum(row["amount"] for row in open_invoices if row["overdue"]),
        "not_due": sum(row["amount"] for row in open_invoices if not row["overdue"]),
        "orders": len(orders), "active_orders": sum(o["status"] == "active" for o in orders),
        "completed_orders": sum(o["status"] == "completed" for o in orders),
        "gross_sales": sum(o["subtotal"] for o in orders),
        "discounts": sum(o["discount"] for o in orders), "net_sales": sum(o["total"] for o in orders),
        "transactions": len(transactions),
        "income_count": sum(t["kind"] == "income" for t in transactions),
        "expense_count": sum(t["kind"] == "expense" for t in transactions),
        "income": sum(t["amount"] for t in transactions if t["kind"] == "income"),
        "expense": sum(t["amount"] for t in transactions if t["kind"] == "expense"),
        "purchase_count": len(purchases), "purchase_value": sum(p["total"] for p in purchases),
    }


def capture(db, year):
    start, cutoff = year_dates(year)
    zone = app_timezone()
    period = {"year": year, "start_date": start, "end_date": cutoff, "start_jalali": jalali(start),
              "end_jalali": jalali(cutoff), "next_year": year + 1, "timezone": zone.key}
    transactions = db.scalars(select(Tx).where(Tx.deleted_at.is_(None), Tx.transaction_date <= cutoff)
                              .order_by(Tx.transaction_date, Tx.transaction_time, Tx.id)).all()
    purchase_links = dict(db.execute(select(PurchasePayment.transaction_id, PurchasePayment.purchase_id).join(
        Tx, Tx.id == PurchasePayment.transaction_id,
    ).where(Tx.deleted_at.is_(None), Tx.transaction_date <= cutoff)).all())
    receipts = defaultdict(list)
    allocations = {}
    for payment, tx in db.execute(select(OrderPayment, Tx).join(Tx, Tx.id == OrderPayment.transaction_id)
                                  .where(Tx.deleted_at.is_(None), Tx.transaction_date <= cutoff)
                                  .order_by(Tx.transaction_date, Tx.transaction_time, Tx.id)):
        receipts[payment.order_id].append((payment, tx))
        allocations[tx.id] = payment
    credits = [tx for tx in transactions if tx.kind == "income" and tx.customer_id and tx.id not in allocations]
    related = {payment.order_id for tx in transactions if tx.transaction_date >= start
               and (payment := allocations.get(tx.id))}
    orders = db.scalars(select(Order).options(defer(Order.invoice_snapshot)).where(
        Order.deleted_at.is_(None), or_(Order.invoice_date <= cutoff, Order.id.in_(receipts)))
        .order_by(Order.invoice_date, Order.id)).all()
    opening_day = start - timedelta(days=1)
    opening_positions = {row.id: row for row in db.execute(select(invoice_positions(opening_day)))}
    closing_query = invoice_positions(cutoff)
    closing_positions = {row.id: row for row in db.execute(select(closing_query))}
    initial_invoices, initial_customers = customer_positions(orders, opening_positions, receipts, credits, opening_day)
    open_invoices, closing_customers = customer_positions(orders, closing_positions, receipts, credits, cutoff)
    by_transaction = {tx.id: tx for tx in transactions}
    applications = db.execute(general_allocations(closing_query, cutoff)).all()
    applied_amounts = Counter()
    for application in applications:
        applied_amounts[application.transaction_id] += application.amount
    related.update(row.order_id for row in applications if by_transaction[row.transaction_id].transaction_date >= start)
    order_ids = related | initial_invoices.keys() | open_invoices.keys() | {o.id for o in orders if o.invoice_date >= start}
    orders = db.scalars(select(Order).options(undefer(Order.invoice_snapshot)).where(Order.id.in_(order_ids))
                        .order_by(Order.invoice_date, Order.id)).all()
    saved_items = {}
    invoices = []
    order_data = []
    credit_customers = {row["customer_id"] for row in initial_customers + closing_customers if row["credit"]}
    linked_ids = {tx.id for tx in credits if tx.customer_id in credit_customers}
    applications = [row for row in applications if row.order_id in order_ids]
    linked_ids.update(row.transaction_id for row in applications)
    for order in orders:
        issued = order.edit_snapshot or order.invoice_snapshot or {}
        source_year = year_of(order.invoice_date)
        in_period = start <= order.invoice_date <= cutoff
        total = order.total
        position = closing_positions.get(order.id)
        paid = position.paid if position else sum(tx.amount for _, tx in receipts[order.id])
        outstanding = position.remaining if position else 0
        linked_ids.update(tx.id for _, tx in receipts[order.id])
        order_data.append({
            **columns(order, {"request_id", "request_fingerprint", "invoice_snapshot", "edit_snapshot", "deleted_at"}),
            "source_year": source_year, "in_period": in_period, "total": total, "paid": paid,
            "remaining": outstanding, "jalali_date": jalali(order.invoice_date),
            "jalali_payment_date": jalali(order.payment_date),
        })
        invoices.append({
            "order_id": order.id, "invoice_code": order.invoice_code, "order_number": order.order_number,
            "customer_id": order.customer_id, "source_year": source_year, "in_period": in_period,
            "issue_date": order.invoice_date, "due_date": order.payment_date, "subtotal": order.subtotal,
            "discount": order.discount, "total": total, "paid": paid, "outstanding": outstanding,
            "issued_customer": issued.get("customer"),
        })
        saved_items.update({item["id"]: item for item in issued.get("items", [])})
    items = [
        {**columns(item), "total": item.quantity * item.unit_price,
         "category_path": saved_items.get(item.id, {}).get("category_path"),
         "product_code": saved_items.get(item.id, {}).get("product_code")}
        for item in db.scalars(select(OrderItem).where(OrderItem.order_id.in_(order_ids))
                              .order_by(OrderItem.order_id, OrderItem.position))
    ]
    bank_data = account_balances(db, year, start, cutoff, zone, transactions)
    bank_names = {b["id"]: b["bank_name"] or b["name"] for b in bank_data if b["id"] is not None}
    cash_ids = {b["id"] for b in bank_data if b["is_cash"]}
    expense_names = dict(db.execute(select(ExpenseCategory.id, ExpenseCategory.title)).all())
    document_names = dict(db.execute(select(DocumentAccount.id, DocumentAccount.title)).all())
    transaction_data, allocation_data, payment_data = [], [], []
    for tx in transactions:
        in_period = tx.transaction_date >= start
        if not in_period and tx.id not in linked_ids:
            continue
        allocation = allocations.get(tx.id)
        method = allocation.method if allocation else tx.payment_method or ("cash" if tx.bank_id in cash_ids else "unknown")
        transaction_data.append({
            **columns(tx, {"request_id", "deleted_at", "payment_method"}), "in_period": in_period, "method": method,
            "jalali_date": jalali(tx.transaction_date), "bank_name": bank_names.get(tx.bank_id),
            "expense_category": (expense_names.get(tx.expense_category_id) or document_names.get(tx.document_account_id)
                                 or tx.title) if tx.kind == "expense" else None,
            "order_id": allocation.order_id if allocation else None,
            "purchase_id": purchase_links.get(tx.id),
        })
        if tx.kind == "income":
            payment_data.append({
                "transaction_id": tx.id, "customer_id": tx.customer_id, "order_id": allocation.order_id if allocation else None,
                "bank_id": tx.bank_id, "date": tx.transaction_date, "jalali_date": jalali(tx.transaction_date),
                "amount": tx.amount, "method": method, "tracking_number": tx.tracking_number, "in_period": in_period,
                "unapplied": 0 if allocation or tx.customer_id is None else tx.amount - applied_amounts[tx.id],
            })
        if allocation:
            allocation_data.append({**columns(allocation), "amount": tx.amount, "in_period": in_period})
    allocation_data.extend({"id": None, "order_id": row.order_id, "transaction_id": row.transaction_id,
                            "method": CUSTOMER_RECEIPT_METHOD, "amount": row.amount,
                            "in_period": by_transaction[row.transaction_id].transaction_date >= start}
                           for row in sorted(applications, key=lambda row: (row.transaction_id, row.order_id)))
    purchases = db.scalars(select(Purchase).where(
        Purchase.deleted_at.is_(None), Purchase.purchase_date.between(start, cutoff))
        .order_by(Purchase.purchase_date, Purchase.id)).all()
    used_customers = ({o.customer_id for o in orders}
                      | {p.supplier_id for p in purchases if p.supplier_id}
                      | {a["customer_id"] for a in initial_customers + closing_customers}
                      | {tx["customer_id"] for tx in transaction_data if tx["customer_id"]})
    customers = []
    for c in db.scalars(select(Customer).order_by(Customer.id)):
        created = local_date(c.created_at, zone)
        at_end = created <= cutoff and (c.deleted_at is None or local_date(c.deleted_at, zone) > cutoff)
        new = start <= created <= cutoff
        if at_end or new or c.id in used_customers:
            customers.append({**columns(c), "created_date": created,
                              "at_year_end": at_end, "new_in_period": new})
    documents = db.scalars(select(Document).where(Document.deleted_at.is_(None),
        or_(Document.date.between(start, cutoff), Document.id.in_(
            {tx["document_id"] for tx in transaction_data if tx["document_id"]}))).order_by(Document.date, Document.id))
    purchase_items = []
    purchase_totals = Counter()
    for item in db.scalars(select(PurchaseItem).where(PurchaseItem.purchase_id.in_([p.id for p in purchases]))
                           .order_by(PurchaseItem.purchase_id, PurchaseItem.position)):
        total = item.quantity * item.purchase_price
        purchase_totals[item.purchase_id] += total
        purchase_items.append({**columns(item), "total": total})
    purchase_history = purchase_payments.payment_history(db, [purchase.id for purchase in purchases], cutoff)
    inventory = inventory_at(db, cutoff)
    saved_inventory = db.get(FiscalInventoryOpening, year)
    opening_inventory = saved_inventory.data if saved_inventory else inventory_at(db, start - timedelta(days=1))
    product_ids = {row["product_id"] for row in items + purchase_items + inventory["rows"] + opening_inventory["rows"]}
    products = {p.id: columns(p, {"stock", "revision"}) for p in db.scalars(select(Product).where(Product.id.in_(product_ids)))}
    for row in inventory["rows"] + opening_inventory["rows"]:
        products.setdefault(row["product_id"], {"id": row["product_id"], "product_code": row["product_code"],
                                               "name": row["name"], "unit": row["unit"]})
    category_ids = {row["category_id"] for row in [*items, *purchase_items, *products.values()] if row.get("category_id")}
    categories = db.scalars(select(InventoryOption).where(InventoryOption.kind == "categories").order_by(InventoryOption.id)).all()
    category_ids.update(c.parent_id for c in categories if c.id in category_ids and c.parent_id)
    data = {
        "schema_version": 1, "period": period, "customers": customers, "orders": order_data,
        "order_items": items, "invoices": invoices, "payments": payment_data, "allocations": allocation_data,
        "transactions": transaction_data,
        "documents": [{**columns(d, {"request_id", "last_request_id", "request_fingerprint", "deleted_at"}),
                       "in_period": start <= d.date <= cutoff} for d in documents],
        "accounts": bank_data,
        "purchases": [{**columns(p, PURCHASE_INTERNAL_FIELDS | {"request_id", "revision", "deleted_at"}), "jalali_date": jalali(p.purchase_date),
                       "total": purchase_totals[p.id] - p.discount + p.tax + p.shipping} for p in purchases],
        "purchase_items": purchase_items,
        "purchase_issuance": {str(p.id): {key: p.invoice_snapshot[key] for key in ("presentation", "supplier")
                                             if key in p.invoice_snapshot}
                              for p in purchases if p.invoice_snapshot},
        "purchase_finances": {str(p.id): {**purchase_payments.balance(
            purchase_totals[p.id] - p.discount + p.tax + p.shipping,
            sum(payment["amount"] for payment in purchase_history[p.id])),
            "payments": purchase_history[p.id]} for p in purchases if p.id in purchase_history},
        "inventory": inventory, "opening_inventory": opening_inventory,
        "products": [products[pid] for pid in sorted(products)],
        "product_categories": [columns(c) for c in categories if c.id in category_ids],
        "expense_categories": [{"id": cid, "title": expense_names[cid]} for cid in
                               sorted({tx["expense_category_id"] for tx in transaction_data if tx["expense_category_id"]})],
        "document_accounts": [columns(a) for a in db.scalars(select(DocumentAccount).where(
            DocumentAccount.id.in_({tx["document_account_id"] for tx in transaction_data if tx["document_account_id"]}))
            .order_by(DocumentAccount.id))],
        "opening_customer_accounts": initial_customers, "closing_customer_accounts": closing_customers,
        "opening_invoices": list(initial_invoices.values()), "closing_invoices": list(open_invoices.values()),
    }
    data["summary"] = summarize(data)
    return jsonable_encoder(data)


def month_index(iso_date):
    return jdatetime.date.fromgregorian(date=date.fromisoformat(iso_date)).month - 1


def group_rows(rows, key):
    grouped = defaultdict(list)
    for row in rows:
        grouped[row[key]].append(row)
    return grouped
