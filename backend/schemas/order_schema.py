from datetime import date
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from schemas.finance_schema import PaymentMethod, normalize_tracking_number, parse_jalali
from schemas.customer_schema import normalize_text

LIMIT = 999999999999


class StrictFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ProductWrite(StrictFields):
    name: str = Field(min_length=1, max_length=150)
    unit: str = Field(min_length=1, max_length=80)
    # Omitted by older clients; the service retains/assigns the Settings category.
    category_id: int | None = Field(default=None, strict=True, gt=0, le=9223372036854775807)
    requires_brand: bool = Field(default=False, strict=True)
    brand_id: int | None = Field(default=None, strict=True, gt=0, le=9223372036854775807)
    price: int = Field(default=0, strict=True, ge=0, le=LIMIT)
    stock: int | None = Field(default=None, strict=True, ge=-1000000000, le=1000000000)
    active: bool = True

    @field_validator("name", "unit", mode="before")
    @classmethod
    def text(cls, value):
        return normalize_text(value) if isinstance(value, str) else value


class ItemWrite(StrictFields):
    product_id: int = Field(strict=True, gt=0, le=9223372036854775807)
    quantity: int = Field(strict=True, gt=0, le=1000000)
    unit_price: int = Field(strict=True, ge=0, le=LIMIT)


class ProductEdit(ProductWrite):
    revision: int = Field(strict=True, gt=0)


class PaymentWrite(StrictFields):
    method: PaymentMethod
    amount: int = Field(strict=True, gt=0, le=LIMIT)
    bank_id: int | None = Field(default=None, strict=True, gt=0, le=9223372036854775807)

    @model_validator(mode="after")
    def source(self):
        if self.method == "cash" and self.bank_id is not None:
            raise ValueError("پرداخت نقدی فقط در صندوق نقدی ثبت می‌شود.")
        if self.method != "cash" and self.bank_id is None:
            raise ValueError("حساب مقصد پرداخت را انتخاب کنید.")
        return self


class SettlementWrite(PaymentWrite):
    request_id: UUID
    transaction_date: date
    tracking_number: str | None = Field(default=None, max_length=100)

    @field_validator("transaction_date", mode="before")
    @classmethod
    def receipt_date(cls, value):
        return parse_jalali(value)

    @field_validator("tracking_number")
    @classmethod
    def tracking(cls, value):
        return normalize_tracking_number(value or None)


class OrderWrite(StrictFields):
    request_id: UUID
    customer_id: int = Field(strict=True, gt=0, le=9223372036854775807)
    order_number: str | None = Field(default=None, min_length=1, max_length=50)
    invoice_date: date
    payment_date: date
    items: list[ItemWrite] = Field(min_length=1, max_length=100)
    payments: list[PaymentWrite] = Field(default_factory=list, max_length=3)
    description: str | None = Field(default=None, max_length=5000)
    discount: int | None = Field(default=None, strict=True, ge=0, le=LIMIT)
    delivery_address: str | None = Field(default=None, max_length=700)
    invoice_number: str | None = Field(default=None, min_length=1, max_length=32)
    invoice_settings_revision: int | None = Field(default=None, strict=True, ge=1)

    @field_validator("invoice_date", "payment_date", mode="before")
    @classmethod
    def date(cls, value):
        return parse_jalali(value)

    @field_validator("order_number", mode="before")
    @classmethod
    def number(cls, value):
        return normalize_text(value) if isinstance(value, str) else value

    @field_validator("description", mode="before")
    @classmethod
    def description_text(cls, value):
        return value.strip() or None if isinstance(value, str) else value

    @model_validator(mode="after")
    def totals(self):
        subtotal = sum(item.quantity * item.unit_price for item in self.items)
        if subtotal > LIMIT or (self.discount is not None and self.discount > subtotal):
            raise ValueError("جمع اقلام یا تخفیف فاکتور معتبر نیست.")
        if len({payment.method for payment in self.payments}) != len(self.payments):
            raise ValueError("هر روش پرداخت فقط یک بار قابل ثبت است.")
        return self


class OrderEdit(OrderWrite):
    revision: int = Field(strict=True, ge=0)
