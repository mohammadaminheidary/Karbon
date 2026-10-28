"""Settings-owned reference lists for purchase entry (no inventory movements)."""
from sqlalchemy import Boolean, CheckConstraint, Column, Integer, String, UniqueConstraint
from database import Base


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
