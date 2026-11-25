"""Project invoice balances and receipt allocations from the financial ledger."""
from datetime import date

from sqlalchemy import case, func, select

from models.finance import FinancialTransaction as Tx
from models.fiscal_year import FiscalYear
from models.order import Order, OrderPayment
from services.fiscal_period import active_value

CUSTOMER_RECEIPT_METHOD = "customer_receipt"


def active_bounds():
    return (func.coalesce(active_value(FiscalYear.start_date).scalar_subquery(), date.min),
            func.coalesce(active_value(FiscalYear.end_date).scalar_subquery(), date.max))


def customer_scope(query, column, customer_ids):
    return query if customer_ids is None else query.where(column.in_(customer_ids))


def direct_receipts(cutoff):
    return select(OrderPayment.order_id, Tx.id.label("transaction_id"), Tx.amount,
                  OrderPayment.method).join(Tx, Tx.id == OrderPayment.transaction_id).where(
        Tx.deleted_at.is_(None), Tx.transaction_date <= cutoff,
    )


def general_receipts(cutoff, customer_ids):
    linked = select(OrderPayment.id).where(OrderPayment.transaction_id == Tx.id).exists()
    return customer_scope(select(Tx.id, Tx.customer_id, Tx.transaction_date, Tx.transaction_time, Tx.amount).where(
        Tx.kind == "income", Tx.customer_id.is_not(None), Tx.deleted_at.is_(None),
        Tx.transaction_date <= cutoff, ~linked,
    ), Tx.customer_id, customer_ids)


def invoice_positions(cutoff, customer_ids=None, *, start=None):
    """Reserve invoice-specific payments, then apply general receipts to oldest invoices.

    Each invoice owns an interval in its customer's cumulative unpaid balance.
    General receipts cover that interval from the beginning. Any unused receipt
    amount remains a credit and can cover invoices issued by a later cutoff.
    """
    orders = customer_scope(select(Order.id, Order.customer_id, Order.total.label("total"),
                                   Order.invoice_date, Order.payment_date).where(
        Order.deleted_at.is_(None), Order.invoice_date <= cutoff,
    ), Order.customer_id, customer_ids).cte()
    direct_columns = [func.sum(Tx.amount).label("paid")]
    general_columns = [func.sum(Tx.amount).label("received")]
    if start is not None:
        direct_columns.append(func.sum(case((Tx.transaction_date >= start, Tx.amount), else_=0)).label("in_period"))
        general_columns.append(func.sum(case((Tx.transaction_date < start, Tx.amount), else_=0)).label("before_period"))
    direct = direct_receipts(cutoff).with_only_columns(OrderPayment.order_id, *direct_columns).join(
        orders, orders.c.id == OrderPayment.order_id,
    ).group_by(OrderPayment.order_id).subquery()
    general = general_receipts(cutoff, customer_ids).with_only_columns(Tx.customer_id, *general_columns).group_by(Tx.customer_id).subquery()

    direct_paid = func.coalesce(direct.c.paid, 0)
    unpaid = func.max(orders.c.total - direct_paid, 0)
    columns = [orders, direct_paid.label("direct_paid"), unpaid.label("unpaid"),
               func.sum(unpaid).over(partition_by=orders.c.customer_id,
                                     order_by=(orders.c.invoice_date, orders.c.id), rows=(None, 0)).label("upper")]
    if start is not None:
        columns.append(func.coalesce(direct.c.in_period, 0).label("direct_in_period"))
    windows = select(*columns).outerjoin(direct, direct.c.order_id == orders.c.id).subquery()
    lower = windows.c.upper - windows.c.unpaid
    covered = func.min(windows.c.upper, func.coalesce(general.c.received, 0))
    applied = func.max(covered - lower, 0)
    columns = [windows.c.id, windows.c.customer_id, windows.c.invoice_date, windows.c.payment_date,
               windows.c.total, windows.c.direct_paid, applied.label("general_paid"),
               (windows.c.direct_paid + applied).label("paid"), (windows.c.unpaid - applied).label("remaining"),
               lower.label("lower"), windows.c.upper]
    if start is not None:
        applied_in_period = func.max(covered - func.max(lower, func.coalesce(general.c.before_period, 0)), 0)
        columns.append((windows.c.direct_in_period + applied_in_period).label("paid_in_period"))
    return select(*columns).select_from(windows).outerjoin(general, general.c.customer_id == windows.c.customer_id).cte()


def general_allocations(positions, cutoff, customer_ids=None):
    """Intersect each receipt's interval with the invoice intervals it covers."""
    receipts = general_receipts(cutoff, customer_ids).add_columns(func.sum(Tx.amount).over(
        partition_by=Tx.customer_id, order_by=(Tx.transaction_date, Tx.transaction_time, Tx.id),
        rows=(None, 0),
    ).label("upper")).subquery()
    lower = receipts.c.upper - receipts.c.amount
    return select(positions.c.id.label("order_id"), receipts.c.id.label("transaction_id"),
                  (func.min(positions.c.upper, receipts.c.upper) - func.max(positions.c.lower, lower)).label("amount")).join(
        receipts, (receipts.c.customer_id == positions.c.customer_id) & (positions.c.general_paid > 0)
        & (receipts.c.upper > positions.c.lower) & (lower < positions.c.upper),
    )


def customer_financial_totals(db, customer_id, cutoff):
    positions = invoice_positions(cutoff, [customer_id]).c
    receipts = select(func.coalesce(func.sum(Tx.amount), 0)).where(
        Tx.customer_id == customer_id, Tx.kind == "income", Tx.deleted_at.is_(None),
        Tx.transaction_date <= cutoff,
    ).scalar_subquery()
    # An issued invoice's applied amount is its total less its live balance.
    # Receipt amounts still waiting for an eligible invoice remain credit.
    invoiced = func.coalesce(func.sum(positions.total), 0)
    outstanding = func.coalesce(func.sum(positions.remaining), 0)
    return db.execute(select(invoiced.label("invoiced"), receipts.label("paid"),
                             outstanding.label("outstanding"),
                             (receipts - (invoiced - outstanding)).label("credit"))).mappings().one()
