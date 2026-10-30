from datetime import datetime, timezone

from sqlalchemy import Column, Date, DateTime, Index, Integer, JSON, String, Text, text

from database import Base
from services.customer_ids import customer_id_default


class CustomerIDRegistry(Base):
    __tablename__ = "customer_id_registry"

    permanent_id = Column(String(18), primary_key=True, nullable=False)


def utc_now():
    return datetime.now(timezone.utc)


class Customer(Base):
    __tablename__ = "customers"
    # Retain the sequence after hard deletes; internal IDs are never reused; display codes may be renumbered.
    __table_args__ = (Index("ux_customers_permanent_id", "permanent_id", unique=True, sqlite_where=text("deleted_at IS NULL")),
                      {"sqlite_autoincrement": True})

    id = Column(Integer, primary_key=True)
    customer_code = Column(Integer, nullable=False, unique=True, index=True)
    gender = Column(String(10), nullable=True)
    first_name = Column(String(100), nullable=False)
    last_name = Column(String(100), nullable=False)
    address = Column(Text, nullable=True)
    last_contact_date = Column(Date, nullable=True)
    phone_numbers = Column(JSON, nullable=False, default=list)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utc_now)
    permanent_id = Column(String(18), nullable=False, default=customer_id_default)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now)

    deleted_at = Column(DateTime(timezone=True), nullable=True)
