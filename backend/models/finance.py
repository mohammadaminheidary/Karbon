from datetime import datetime, timezone

from sqlalchemy import BigInteger, CheckConstraint, Column, Date, DateTime, ForeignKey, Index, Integer, String, Text, Boolean

from database import Base


def utc_now():
    return datetime.now(timezone.utc)


class BankDirectory(Base):
    __tablename__ = "bank_directory"
    code = Column(String(40), primary_key=True)
    name = Column(String(100), nullable=False, unique=True)
    logo_url = Column(String(200), nullable=False)
    active = Column(Boolean, nullable=False, default=True)


class BankAccount(Base):
    __tablename__ = "bank_accounts"
    id = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False)
    account_number = Column(String(50), nullable=False, unique=True)
    opening_balance = Column(BigInteger, nullable=False, default=0)
    active = Column(Boolean, nullable=False, default=True)
    # Nullable only for accounts created before bank profiles were introduced.
    first_name = Column(String(100), nullable=True)
    last_name = Column(String(100), nullable=True)
    bank = Column(String(40), ForeignKey("bank_directory.code", ondelete="RESTRICT"), nullable=True)
    card_number = Column(String(16), nullable=True, unique=True)
    sheba_number = Column(String(26), nullable=True, unique=True)
    created_at = Column(DateTime(timezone=True), nullable=True, default=utc_now)
    updated_at = Column(DateTime(timezone=True), nullable=True, default=utc_now, onupdate=utc_now)
    deleted_at = Column(DateTime(timezone=True), nullable=True)


class ExpenseCategory(Base):
    __tablename__ = "expense_categories"
    __table_args__ = {"sqlite_autoincrement": True}
    id = Column(Integer, primary_key=True)
    title = Column(String(150), nullable=False, unique=True)
    active = Column(Boolean, nullable=False, default=True)
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    display_code = Column(Integer, nullable=True)

    @property
    def account_code(self):
        return f"E-{(self.display_code or self.id):06d}"


class FinancialTransaction(Base):
    __tablename__ = "financial_transactions"
    __table_args__ = (
        CheckConstraint("amount > 0 AND amount <= 999999999999", name="positive_financial_amount"),
        CheckConstraint("(kind = 'income' AND customer_id IS NOT NULL AND expense_category_id IS NULL) OR (kind = 'expense' AND customer_id IS NULL AND expense_category_id IS NOT NULL)", name="financial_source"),
        CheckConstraint("time_mode IN ('auto', 'manual')", name="financial_time_mode"),
        Index("ix_finance_date_time", "transaction_date", "transaction_time", "id"),
    )
    id = Column(Integer, primary_key=True)
    transaction_number = Column(Integer, nullable=True)
    request_id = Column(String(36), nullable=False, unique=True)
    kind = Column(String(10), nullable=False)
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="RESTRICT"), nullable=True, index=True)
    expense_category_id = Column(Integer, ForeignKey("expense_categories.id", ondelete="RESTRICT"), nullable=True)
    bank_id = Column(Integer, ForeignKey("bank_accounts.id", ondelete="RESTRICT"), nullable=False, index=True)
    # Preserve historical titles; display codes follow the current source numbering.
    title = Column(String(201), nullable=False)
    account_code = Column(String(50), nullable=False)
    amount = Column(BigInteger, nullable=False)
    tracking_number = Column(String(100), nullable=True)
    description = Column(Text, nullable=True)
    transaction_date = Column(Date, nullable=False)
    transaction_time = Column(String(8), nullable=False)
    time_mode = Column(String(10), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), nullable=True, default=utc_now)
    deleted_at = Column(DateTime(timezone=True), nullable=True)
