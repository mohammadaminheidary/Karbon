from sqlalchemy import Column, Integer, String, DateTime
from datetime import datetime

from database import Base



class User(Base):

    __tablename__ = "users"



    id = Column(
        Integer,
        primary_key=True,
        index=True
    )


    username = Column(
        String(50),
        unique=True,
        nullable=False,
        index=True
    )


    password_hash = Column(
        String(255),
        nullable=False
    )

    auth_version = Column(Integer, nullable=False, default=0, server_default="0")


    created_at = Column(
        DateTime,
        default=datetime.utcnow
    )
