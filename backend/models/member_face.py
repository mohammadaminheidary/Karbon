from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, Integer, LargeBinary, String

from database import Base


class MemberFace(Base):
    """Encrypted SFace templates, including existing four-sample registrations."""

    __tablename__ = "member_faces"

    member_id = Column(Integer, ForeignKey("members.id", ondelete="CASCADE"), primary_key=True)
    encrypted_template = Column(LargeBinary, nullable=False)
    model_version = Column(String(40), nullable=False, default="sface-2021dec-v1")
    consented_at = Column(DateTime, nullable=False)
    updated_at = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))


class MemberFacePhoto(Base):
    """Three encrypted photos; kept separate so matching never loads JPEGs.

    A separate table lets create_all upgrade existing installations without
    altering their templates. Replacing a registration also removes any old
    fourth-angle photo, while existing templates remain usable for recognition.
    """

    __tablename__ = "member_face_photos"

    member_id = Column(Integer, ForeignKey("member_faces.member_id", ondelete="CASCADE"), primary_key=True)
    angle = Column(String(10), primary_key=True)
    encrypted_image = Column(LargeBinary, nullable=False)
