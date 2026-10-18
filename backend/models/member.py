from datetime import datetime

from sqlalchemy import (
    Column,
    DateTime,
    Integer,
    String,
    select,
)

from sqlalchemy.orm import column_property, relationship

from database import Base
from models.member_face import MemberFace


class Member(Base):

    __tablename__ = "members"


    id = Column(
        Integer,
        primary_key=True,
        index=True,
    )

    # Expose enrollment state without loading or exporting encrypted templates.
    face_registered = column_property(
        select(MemberFace.member_id).where(MemberFace.member_id == id).exists()
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
