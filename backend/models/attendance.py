from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Time,
    UniqueConstraint,
)

from sqlalchemy.orm import relationship

from database import Base


class Attendance(Base):

    __tablename__ = "attendance"


    __table_args__ = (
        UniqueConstraint(
            "member_id",
            "date",
            name="uq_attendance_member_date",
        ),

        CheckConstraint(
            "status IN ('present', 'absent')",
            name="ck_attendance_status",
        ),
    )


    id = Column(
        Integer,
        primary_key=True,
        index=True,
    )


    member_id = Column(
        Integer,
        ForeignKey(
            "members.id",
            ondelete="CASCADE",
        ),
        nullable=False,
        index=True,
    )


    date = Column(
        Date,
        nullable=False,
        index=True,
    )


    status = Column(
        String(10),
        nullable=False,
    )


    recorded_time = Column(
        Time,
        nullable=False,
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


    member = relationship(
        "Member",
        back_populates="attendance_records",
    )