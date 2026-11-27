from sqlalchemy import BigInteger, Boolean, CheckConstraint, Column, Date, DateTime, ForeignKey, ForeignKeyConstraint, Index, Integer, JSON, LargeBinary, String

from database import Base
from models.finance import utc_now


class FiscalYear(Base):
    __tablename__ = "fiscal_years"
    year = Column(Integer, primary_key=True, autoincrement=False)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False, index=True)
    closed_at = Column(DateTime(timezone=True))


class FiscalSnapshot(Base):
    __tablename__ = "fiscal_snapshots"
    year = Column(ForeignKey("fiscal_years.year"), primary_key=True)
    version = Column(Integer, primary_key=True)
    closed_at = Column(DateTime(timezone=True), nullable=False)
    export_status = Column(String(12), nullable=False)
    digest = Column(String(64), nullable=False)
    backup_filename = Column(String(100), nullable=False)
    data = Column(JSON, nullable=False)


class FiscalBankOpening(Base):
    __tablename__ = "fiscal_bank_openings"
    year = Column(ForeignKey("fiscal_years.year"), primary_key=True)
    bank_id = Column(ForeignKey("bank_accounts.id"), primary_key=True)
    balance = Column(BigInteger, nullable=False)


class FiscalCustomerOpening(Base):
    __tablename__ = "fiscal_customer_openings"
    year = Column(ForeignKey("fiscal_years.year"), primary_key=True)
    customer_id = Column(ForeignKey("customers.id"), primary_key=True)
    receivable = Column(BigInteger, nullable=False)
    credit = Column(BigInteger, nullable=False)


class FiscalInvoiceOpening(Base):
    __tablename__ = "fiscal_invoice_openings"
    year = Column(ForeignKey("fiscal_years.year"), primary_key=True)
    order_id = Column(ForeignKey("orders.id"), primary_key=True)
    customer_id = Column(ForeignKey("customers.id"), nullable=False)
    source_year = Column(Integer, nullable=False)
    paid = Column(BigInteger, nullable=False)
    amount = Column(BigInteger, nullable=False)
    __table_args__ = (Index("ix_fiscal_invoice_openings_customer", "year", "customer_id"),)


class FiscalInventoryOpening(Base):
    __tablename__ = "fiscal_inventory_openings"
    year = Column(ForeignKey("fiscal_years.year"), primary_key=True)
    data = Column(JSON, nullable=False)


class FiscalExport(Base):
    __tablename__ = "fiscal_exports"
    __table_args__ = (ForeignKeyConstraint(["year", "version"], ["fiscal_snapshots.year", "fiscal_snapshots.version"]),)
    year = Column(Integer, primary_key=True)
    version = Column(Integer, primary_key=True)
    kind = Column(String(20), primary_key=True)
    content = Column(LargeBinary, nullable=False)


class InventoryHistory(Base):
    __tablename__ = "fiscal_inventory_history"
    id = Column(Integer, primary_key=True)
    available_from = Column(Date, nullable=False)
    warehouse_available_from = Column(Date)


class InventoryChange(Base):
    __tablename__ = "fiscal_inventory_changes"
    __table_args__ = (Index("ux_inventory_change_reference_product", "reference", "product_id", unique=True),
                      Index("ix_inventory_change_product_id", "product_id", "id"),
                      Index("ix_inventory_change_scope_product", "scope", "product_id"),
                      CheckConstraint("scope IN ('sales', 'warehouse')"))
    id = Column(Integer, primary_key=True)
    reference = Column(String(100), nullable=False)
    scope = Column(String(12), nullable=False, server_default="sales")
    posted_at = Column(DateTime(timezone=True), nullable=True, default=utc_now)
    # Catalog records can be removed. The journal retains their identity.
    product_id = Column(Integer, nullable=False)
    business_date = Column(Date, nullable=False, index=True)
    delta = Column(Integer, nullable=False)
    tracked = Column(Boolean)
    name = Column(String(150), nullable=False)
    product_code = Column(String(32))
    unit = Column(String(80), nullable=False)


FISCAL_TABLES = tuple(model.__table__ for model in (
    FiscalYear, FiscalSnapshot, FiscalBankOpening, FiscalCustomerOpening,
    FiscalInvoiceOpening, FiscalInventoryOpening, FiscalExport, InventoryHistory, InventoryChange,
))
