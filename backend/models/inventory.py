"""Settings reference lists, purchase receipts and production records."""
from sqlalchemy import BigInteger, Boolean, CheckConstraint, Column, Date, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint
from database import Base
from models.finance import utc_now


class Brand(Base):
    __tablename__ = "brands"
    __table_args__ = {"sqlite_autoincrement": True}
    id = Column(Integer, primary_key=True)
    name = Column(String(80), nullable=False, unique=True)


class InventoryOption(Base):
    __tablename__ = "inventory_options"
    __table_args__ = (
        UniqueConstraint("kind", "name"),
        CheckConstraint("kind IN ('categories', 'units')"),
        {"sqlite_autoincrement": True},
    )
    id = Column(Integer, primary_key=True)
    kind = Column(String(12), nullable=False)
    name = Column(String(80), nullable=False)
    active = Column(Boolean, nullable=False, default=True)
    parent_id = Column(Integer, ForeignKey("inventory_options.id", ondelete="RESTRICT"), nullable=True)


class Purchase(Base):
    __tablename__ = "purchases"
    __table_args__ = (
        CheckConstraint("quantity > 0 AND quantity <= 1000000"),
        CheckConstraint("purchase_price >= 0 AND quantity * purchase_price <= 999999999999"),
        {"sqlite_autoincrement": True},
    )
    id = Column(Integer, primary_key=True)
    request_id = Column(String(36), nullable=False, unique=True)
    request_fingerprint = Column(String(64), nullable=False)
    revision = Column(Integer, nullable=False, default=1, server_default="1")
    last_edit_id = Column(String(36), nullable=True)
    last_edit_fingerprint = Column(String(64), nullable=True)
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    invoice_number = Column(String(32), nullable=False, unique=True)
    purchase_date = Column(Date, nullable=False)
    supplier_id = Column(Integer, ForeignKey("customers.id", ondelete="RESTRICT"), nullable=True, index=True)
    discount = Column(BigInteger, nullable=False, default=0, server_default="0")
    tax = Column(BigInteger, nullable=False, default=0, server_default="0")
    shipping = Column(BigInteger, nullable=False, default=0, server_default="0")
    invoice_snapshot = Column(JSON, nullable=True)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="RESTRICT"), nullable=False, index=True)
    category_id = Column(Integer, ForeignKey("inventory_options.id", ondelete="RESTRICT"), nullable=False)
    category_name = Column(String(80), nullable=False)
    category_parent_name = Column(String(80), nullable=True)
    product_name = Column(String(150), nullable=False)
    brand_name = Column(String(80), nullable=True)
    unit = Column(String(80), nullable=False)
    quantity = Column(Integer, nullable=False)
    purchase_price = Column(BigInteger, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utc_now)


class PurchaseItem(Base):
    __tablename__ = "purchase_items"
    __table_args__ = (
        UniqueConstraint("purchase_id", "position"),
        CheckConstraint("position > 0 AND position <= 100"),
        CheckConstraint("quantity > 0 AND quantity <= 1000000"),
        CheckConstraint("purchase_price >= 0 AND quantity * purchase_price <= 999999999999"),
        {"sqlite_autoincrement": True},
    )
    id = Column(Integer, primary_key=True)
    purchase_id = Column(Integer, ForeignKey("purchases.id", ondelete="RESTRICT"), nullable=False, index=True)
    position = Column(Integer, nullable=False)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="RESTRICT"), nullable=False, index=True)
    category_id = Column(Integer, ForeignKey("inventory_options.id", ondelete="RESTRICT"), nullable=False)
    category_name = Column(String(80), nullable=False)
    category_parent_name = Column(String(80), nullable=True)
    product_name = Column(String(150), nullable=False)
    brand_name = Column(String(80), nullable=True)
    unit = Column(String(80), nullable=False)
    quantity = Column(Integer, nullable=False)
    purchase_price = Column(BigInteger, nullable=False)


class ProductionRun(Base):
    __tablename__ = "production_runs"
    __table_args__ = {"sqlite_autoincrement": True}
    id = Column(Integer, primary_key=True)
    request_id = Column(String(36), nullable=False, unique=True)
    request_fingerprint = Column(String(64), nullable=False)
    production_date = Column(Date, nullable=False, index=True)
    description = Column(String(500), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utc_now)
    deleted_at = Column(DateTime(timezone=True), nullable=True)
