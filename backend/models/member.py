from datetime import datetime

from sqlalchemy import (
    Column,
    DateTime,
    Integer,
    String,
)

from sqlalchemy.orm import relationship

from database import Base


class Member(Base):

    __tablename__ = "members"


    id = Column(
        Integer,
        primary_key=True,
        index=True,
    )


    first_name = Column(
        String(100),
        nullable=False,
    )


    last_name = Column(
        String(100),
        nullable=False,
    )


    phone = Column(
        String(20),
        nullable=True,
    )


    national_id = Column(
        String(20),
        nullable=True,
    )


    created_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
    )


    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


    attendance_records = relationship(
        "Attendance",
        back_populates="member",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )