"""Protect product references in existing production history."""
from sqlalchemy import String, cast, or_, select

from models.fiscal_year import InventoryChange
from models.inventory import ProductionRun


def production_stock_products(period=None):
    reference = "production:" + cast(ProductionRun.id, String)
    query = select(InventoryChange.product_id).join(ProductionRun, or_(
        InventoryChange.reference == reference + ":inputs",
        InventoryChange.reference == reference + ":outputs",
    )).where(ProductionRun.deleted_at.is_(None))
    if period:
        query = query.where(ProductionRun.production_date >= period.start_date)
    return query


def has_production_stock(db, product_id, period=None):
    return db.scalar(production_stock_products(period).where(InventoryChange.product_id == product_id).limit(1)) is not None
