"""Immutable exported files, stored atomically with their history metadata."""
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, JSON, LargeBinary, String
from sqlalchemy.orm import deferred

from database import Base


class GeneratedReport(Base):
    __tablename__ = "generated_reports"
    __table_args__ = (Index("ix_generated_reports_owner_created", "user_id", "created_at", "id"),)

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(200), nullable=False)
    dataset = Column(String(100), nullable=False)
    format = Column(String(4), nullable=False)
    created_at = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    record_count = Column(Integer, nullable=False)
    column_count = Column(Integer, nullable=False)
    size_bytes = Column(Integer, nullable=False)
    parameters = deferred(Column(JSON, nullable=False))
    content = deferred(Column(LargeBinary, nullable=False))
