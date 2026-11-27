from sqlalchemy import Boolean, CheckConstraint, Column, Integer, String

from database import Base


class BackupSettings(Base):
    __tablename__ = "backup_settings"
    __table_args__ = (
        CheckConstraint("id = 1"),
        CheckConstraint("reminder_enabled IN (0, 1)"),
        CheckConstraint("reminder_hours BETWEEN 1 AND 8760"),
    )

    id = Column(Integer, primary_key=True)
    reminder_enabled = Column(Boolean, nullable=False)
    reminder_hours = Column(Integer, nullable=False)
    started_at = Column(String, nullable=False)
