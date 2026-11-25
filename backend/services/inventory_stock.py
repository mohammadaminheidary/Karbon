"""Post stock and its journal in the caller's SQLite write transaction."""
from collections import Counter
from dataclasses import dataclass
from datetime import date

from sqlalchemy import case, distinct, func, select

from models.fiscal_year import InventoryChange, InventoryHistory
from services.finance_service import FinanceError


MAX_STOCK = 1_000_000_000


@dataclass(frozen=True)
class StockPosting:
    reference: str
    day: date
    quantities: dict[int, int]


def post_stock(db, products, *postings, tracked=None, retiring=False):
    """Validate final balances, update the catalog, and append each posting."""
    balances = {}
    changes = []
    changed_products = set()
    for posting in postings:
        for product_id, delta in posting.quantities.items():
            product = products[product_id]
            if delta and product.stock is None and tracked is not True:
                raise FinanceError(f"کنترل موجودی «{product.name}» فعال نیست.", 409)
            balances[product_id] = balances.get(product_id, product.stock or 0) + delta
            if delta:
                changed_products.add(product_id)
            changes.append(InventoryChange(
                reference=posting.reference, product_id=product_id,
                business_date=posting.day, delta=delta, tracked=tracked,
                name=product.name, product_code=product.product_code, unit=product.unit,
            ))
    for product_id, balance in balances.items():
        product = products[product_id]
        validate_balance(product, balance)
        if tracked is not None:
            if not retiring:
                product.stock = balance if tracked else None
        elif product.stock is not None:
            product.stock = balance
            if product_id in changed_products:
                product.revision += 1
    db.add_all(changes)
    db.flush()


def validate_balance(product, balance):
    if abs(balance) > MAX_STOCK:
        raise FinanceError(f"موجودی «{product.name}» بیش از حد مجاز است.", 422)


def quantities_for(db, reference):
    return dict(db.execute(select(InventoryChange.product_id, InventoryChange.delta)
                           .where(InventoryChange.reference == reference)).all())


def line_quantities(rows):
    quantities = Counter()
    for row in rows:
        quantities[row.product_id] += row.quantity
    return quantities


def opposite(quantities):
    return {product_id: -quantity for product_id, quantity in quantities.items()}


def inventory_movements(db, product_id, skip, limit):
    query = select(InventoryChange)
    if product_id is not None:
        query = query.where(InventoryChange.product_id == product_id)
    history = db.get(InventoryHistory, 1)
    rows = db.scalars(query.order_by(InventoryChange.id.desc()).offset(skip).limit(limit + 1)).all()
    return {"available_from": history.available_from, "has_more": len(rows) > limit,
            "items": [{column.name: getattr(row, column.name) for column in InventoryChange.__table__.columns}
                      for row in rows[:limit]]}


def movement_summary(db, day):
    # Count distinct products with real movements. Initial legacy balances are
    # opening inventory, not today's receipts.
    product = InventoryChange.product_id
    delta = InventoryChange.delta
    incoming, outgoing = db.execute(select(
        func.count(distinct(case((delta > 0, product)))),
        func.count(distinct(case((delta < 0, product)))),
    ).where(
        InventoryChange.business_date == day, InventoryChange.tracked.is_(None))
    ).one()
    return {"incoming": incoming, "outgoing": outgoing}
