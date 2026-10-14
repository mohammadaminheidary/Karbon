from datetime import date
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from schemas.finance_schema import parse_jalali
from schemas.customer_schema import normalize_text

LIMIT = 999999999999


class StrictFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ProductWrite(StrictFields):
    name: str = Field(min_length=1, max_length=150)
    unit: str = Field(min_length=1, max_length=30)
    price: int = Field(strict=True, ge=0, le=LIMIT)
    stock: int | None = Field(default=None, strict=True, ge=0, le=1000000000)
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
    method: Literal["pos", "cash", "transfer"]
    amount: int = Field(strict=True, gt=0, le=LIMIT)
    bank_id: int | None = Field(default=None, strict=True, gt=0, le=9223372036854775807)

    @model_validator(mode="after")
    def source(self):
        if self.method == "cash" and self.bank_id is not None:
            raise ValueError("پرداخت نقدی فقط در صندوق نقدی ثبت می‌شود.")
        if self.method != "cash" and self.bank_id is None:
            raise ValueError("حساب مقصد پرداخت را انتخاب کنید.")
        return self


class OrderWrite(StrictFields):
    request_id: UUID
    customer_id: int = Field(strict=True, gt=0, le=9223372036854775807)
    order_number: str | None = Field(default=None, min_length=1, max_length=50)
    invoice_date: date
    payment_date: date
    items: list[ItemWrite] = Field(min_length=1, max_length=100)
    payments: list[PaymentWrite] = Field(default_factory=list, max_length=3)
    description: str | None = Field(default=None, max_length=5000)
    discount: int = Field(default=0, strict=True, ge=0, le=LIMIT)

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
        if subtotal > LIMIT or self.discount > subtotal:
            raise ValueError("جمع اقلام یا تخفیف فاکتور معتبر نیست.")
        if sum(payment.amount for payment in self.payments) > subtotal - self.discount:
            raise ValueError("مجموع پرداخت‌ها نباید از مبلغ نهایی فاکتور بیشتر باشد.")
        if len({payment.method for payment in self.payments}) != len(self.payments):
            raise ValueError("هر روش پرداخت فقط یک بار قابل ثبت است.")
        return self
