"""Orders own invoice data; payments reference the existing financial ledger."""
from sqlalchemy import BigInteger, Boolean, CheckConstraint, Column, Date, DateTime, ForeignKey, Index, Integer, String, Text, JSON, text
from sqlalchemy.orm import relationship
from sqlalchemy.ext.hybrid import hybrid_property
from database import Base
from models.finance import utc_now

CASH_ACCOUNT_NUMBER = "KARBON-CASH"
PRODUCT_BRAND_CHECK = "(requires_brand = 0 AND brand_id IS NULL) OR (requires_brand = 1 AND brand_id IS NOT NULL)"


class Product(Base):
    __tablename__ = "products"
    __table_args__ = (CheckConstraint("price >= 0 AND price <= 999999999999"), CheckConstraint(PRODUCT_BRAND_CHECK),
                      CheckConstraint("catalog IN ('sales', 'warehouse')"),
                      Index("ux_products_catalog_name_brand", "catalog", "name", text("COALESCE(brand_id, 0)"), unique=True),
                      Index("ux_products_legacy_product_id", "legacy_product_id", unique=True),
                      {"sqlite_autoincrement": True})
    id = Column(Integer, primary_key=True)
    catalog = Column(String(12), nullable=False, server_default="sales")
    legacy_product_id = Column(Integer, nullable=True)
    product_code = Column(String(32), nullable=True, unique=True)
    revision = Column(Integer, nullable=False, default=1)
    name = Column(String(150), nullable=False)
    unit = Column(String(80), nullable=False)
    category_id = Column(Integer, ForeignKey("inventory_options.id", ondelete="RESTRICT"), nullable=True)
    warehouse_category_id = Column(Integer, ForeignKey("inventory_options.id", ondelete="RESTRICT"), nullable=True, index=True)
    requires_brand = Column(Boolean, nullable=False, default=False, server_default="0")
    brand_id = Column(Integer, ForeignKey("brands.id", ondelete="RESTRICT"), index=True)
    brand = relationship("Brand")
    price = Column(BigInteger, nullable=False)
    # NULL means a service / item whose inventory is not tracked.
    stock = Column(Integer, nullable=True)
    active = Column(Boolean, nullable=False, default=True)
    deleted_at = Column(DateTime(timezone=True), nullable=True)


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (CheckConstraint("subtotal >= 0 AND subtotal <= 999999999999 AND discount >= 0 AND discount <= subtotal"), CheckConstraint("status IN ('active', 'completed')"), {"sqlite_autoincrement": True})
    id = Column(Integer, primary_key=True)
    request_id = Column(String(36), nullable=False, unique=True)
    request_fingerprint = Column(String(64), nullable=False)
    invoice_code = Column(String(40), nullable=False, unique=True)
    order_number = Column(String(50), nullable=False, unique=True)
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False, index=True)
    invoice_date = Column(Date, nullable=False)
    payment_date = Column(Date, nullable=False)
    description = Column(Text, nullable=True)
    subtotal = Column(BigInteger, nullable=False)
    discount = Column(BigInteger, nullable=False)
    tax = Column(BigInteger, nullable=False, default=0, server_default="0")
    shipping = Column(BigInteger, nullable=False, default=0, server_default="0")
    status = Column(String(12), nullable=False, default="active")
    created_at = Column(DateTime(timezone=True), nullable=False, default=utc_now)
    invoice_snapshot = Column(JSON, nullable=True)
    edit_snapshot = Column(JSON, nullable=True)
    deleted_at = Column(DateTime(timezone=True), nullable=True)


    @hybrid_property
    def total(self):
        return self.subtotal - self.discount + self.tax + self.shipping


class OrderItem(Base):
    __tablename__ = "order_items"
    __table_args__ = (CheckConstraint("quantity > 0 AND quantity <= 1000000"), CheckConstraint("unit_price >= 0 AND unit_price <= 999999999999"))
    id = Column(Integer, primary_key=True)
    order_id = Column(Integer, ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False, index=True)
    product_id = Column(Integer, ForeignKey("products.id", ondelete="RESTRICT"), nullable=False)
    category_id = Column(Integer, ForeignKey("inventory_options.id", ondelete="RESTRICT"), nullable=True)
    position = Column(Integer, nullable=False)
    product_name = Column(String(150), nullable=False)
    brand_name = Column(String(80), nullable=True)
    unit = Column(String(80), nullable=False)
    quantity = Column(Integer, nullable=False)
    unit_price = Column(BigInteger, nullable=False)


class OrderPayment(Base):
    __tablename__ = "order_payments"
    __table_args__ = (CheckConstraint("method IN ('pos', 'cash', 'transfer')"),)
    id = Column(Integer, primary_key=True)
    order_id = Column(Integer, ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False, index=True)
    transaction_id = Column(Integer, ForeignKey("financial_transactions.id", ondelete="RESTRICT"), nullable=False, unique=True)
    method = Column(String(12), nullable=False)
