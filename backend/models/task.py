from datetime import datetime

from sqlalchemy import CheckConstraint, Column, Date, DateTime, Integer, String, Text

from database import Base


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        CheckConstraint("status IN ('todo', 'in_progress', 'completed')", name="task_status"),
    )

    id = Column(Integer, primary_key=True)
    date = Column(Date, nullable=False)
    title = Column(String(200), nullable=False)
    description = Column(Text, nullable=False, default="")
    status = Column(String(20), nullable=False, default="todo")
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
