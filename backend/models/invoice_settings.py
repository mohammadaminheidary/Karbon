"""Invoice settings are shared by the business represented by this database."""
from sqlalchemy import CheckConstraint, Column, ForeignKey, Integer, JSON, LargeBinary, String, UniqueConstraint

from database import Base


class InvoiceSettings(Base):
    __tablename__ = "invoice_settings"
    id = Column(Integer, primary_key=True)
    revision = Column(Integer, nullable=False)
    data = Column(JSON, nullable=False)


class InvoiceAsset(Base):
    __tablename__ = "invoice_assets"
    id = Column(String(64), primary_key=True)
    mime = Column(String(16), nullable=False)
    content = Column(LargeBinary, nullable=False)


class InvoiceTemplate(Base):
    __tablename__ = "invoice_templates"
    __table_args__ = (
        UniqueConstraint("kind", "name"),
        CheckConstraint("kind IN ('sale', 'purchase')"),
        {"sqlite_autoincrement": True},
    )
    id = Column(Integer, primary_key=True)
    kind = Column(String(8), nullable=False)
    name = Column(String(100), nullable=False)
    revision = Column(Integer, nullable=False, default=1)


class InvoiceLayoutVersion(Base):
    __tablename__ = "invoice_layout_versions"
    __table_args__ = (UniqueConstraint("template_id", "revision"), {"sqlite_autoincrement": True})
    id = Column(Integer, primary_key=True)
    # Retain versions after the template is deleted so issued invoices remain reproducible.
    template_id = Column(Integer, nullable=False, index=True)
    revision = Column(Integer, nullable=False)
    layout = Column(JSON, nullable=False)


class InvoiceTemplateDefault(Base):
    __tablename__ = "invoice_template_defaults"
    kind = Column(String(8), primary_key=True)
    template_id = Column(Integer, ForeignKey("invoice_templates.id", ondelete="RESTRICT"), nullable=False)


class InvoiceSequence(Base):
    __tablename__ = "invoice_sequences"
    kind = Column(String(8), primary_key=True)
    year = Column(Integer, primary_key=True)
    next_value = Column(Integer, nullable=False)
