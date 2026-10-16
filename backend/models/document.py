from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, Column, Date, DateTime, Index, Integer, String, Text

from database import Base


class DocumentAccount(Base):
    __tablename__ = "document_accounts"
    __table_args__ = (CheckConstraint("kind IN ('income', 'expense')", name="document_account_kind"),)
    id = Column(Integer, primary_key=True)
    code = Column(String(50), nullable=False, unique=True)
    title = Column(String(201), nullable=False)
    kind = Column(String(10), nullable=False)
    active = Column(Boolean, nullable=False, default=True)
    deleted_at = Column(DateTime, nullable=True)


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (Index("ix_documents_date_id", "date", "id"),)

    id = Column(Integer, primary_key=True)
    number = Column(String(100), nullable=False, unique=True)
    description = Column(Text, nullable=False, default="")
    date = Column(Date, nullable=False)
    document_type = Column(String(100), nullable=False, index=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    request_id = Column(String(36), nullable=True, unique=True)
    last_request_id = Column(String(36), nullable=True, unique=True)
    request_fingerprint = Column(String(64), nullable=True)
    revision = Column(Integer, nullable=False, default=1)
    deleted_at = Column(DateTime, nullable=True)
