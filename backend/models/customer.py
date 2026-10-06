from datetime import datetime, timezone

from sqlalchemy import Column, Date, DateTime, Integer, JSON, String, Text

from database import Base


def utc_now():
    return datetime.now(timezone.utc)


class Customer(Base):
    __tablename__ = "customers"
    # Retain the sequence after hard deletes; internal IDs are never reused; display codes may be renumbered.
    __table_args__ = {"sqlite_autoincrement": True}

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
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now)

    deleted_at = Column(DateTime(timezone=True), nullable=True)
