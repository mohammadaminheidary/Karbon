import re
import jdatetime
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")


def normalize_text(value: str) -> str:
    return " ".join(value.translate(DIGITS).replace("ي", "ی").replace("ك", "ک").split())


def normalize_phone(value: str) -> str:
    value = re.sub(r"[\s()\-]", "", value.translate(DIGITS))
    if value.startswith("00"):
        value = "+" + value[2:]
    if value.startswith("+98"):
        value = "0" + value[3:]
    if not re.fullmatch(r"\+?[0-9]{7,15}", value):
        raise ValueError("شماره تلفن باید بین ۷ تا ۱۵ رقم باشد.")
    return value


class CustomerWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    gender: Literal["male", "female"] | None = None
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    address: str | None = Field(default=None, max_length=2000)
    last_contact_date: date | None = None
    phone_numbers: list[str] = Field(default_factory=list, max_length=20)
    notes: str | None = Field(default=None, max_length=5000)
    confirm_duplicate: bool = False

    @field_validator("last_contact_date", mode="before")
    @classmethod
    def contact_date(cls, value):
        if not isinstance(value, str):
            return value
        value = value.translate(DIGITS).strip()
        if not value:
            return None
        # Slash-separated values are explicitly Jalali. ISO Gregorian values
        # stay compatible with existing API clients and stored dates.
        if "/" not in value:
            return value
        match = re.fullmatch(r"([0-9]{4})/([0-9]{1,2})/([0-9]{1,2})", value)
        if not match:
            raise ValueError("تاریخ شمسی را به صورت ۱۴۰۵/۰۷/۱۴ وارد کنید.")
        try:
            year, month, day = map(int, match.groups())
            return jdatetime.date(year, month, day).togregorian()
        except (ValueError, OverflowError):
            raise ValueError("تاریخ شمسی واردشده معتبر نیست.") from None

    @field_validator("first_name", "last_name", mode="before")
    @classmethod
    def names(cls, value):
        if isinstance(value, str):
            value = normalize_text(value)
            if not value:
                raise ValueError("نام و نام خانوادگی الزامی است.")
        return value

    @field_validator("address", "notes", mode="before")
    @classmethod
    def optional_text(cls, value):
        return value.strip() or None if isinstance(value, str) else value

    @field_validator("phone_numbers")
    @classmethod
    def phones(cls, values):
        # Keep input order: index zero is the primary number.
        return list(dict.fromkeys(normalize_phone(value) for value in values))


class CustomerSummary(BaseModel):
    order_count: int = 0
    total_orders: int = 0
    paid: int = 0
    debt: int = 0
    status: Literal["debtor", "settled", "no_payment"] = "no_payment"
    available: bool = False


class CustomerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    customer_code: int
    gender: Literal["male", "female"] | None
    first_name: str
    last_name: str
    address: str | None
    last_contact_date: date | None
    phone_numbers: list[str]
    notes: str | None
    created_at: datetime
    updated_at: datetime
    summary: CustomerSummary


class CustomerList(BaseModel):
    items: list[CustomerResponse]
    total: int
    skip: int
    limit: int
