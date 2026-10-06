import re
import unicodedata
from datetime import date
from typing import Literal
from uuid import UUID

import jdatetime
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from schemas.customer_schema import DIGITS, normalize_text


def parse_jalali(value):
    if not isinstance(value, str):
        raise ValueError("تاریخ شمسی را به صورت ۱۴۰۵/۰۷/۱۴ وارد کنید.")
    match = re.fullmatch(r"([0-9]{4})/([0-9]{1,2})/([0-9]{1,2})", value.translate(DIGITS).strip())
    try:
        if not match:
            raise ValueError()
        return jdatetime.date(*map(int, match.groups())).togregorian()
    except (ValueError, OverflowError):
        raise ValueError("تاریخ شمسی واردشده معتبر نیست.") from None


class BankWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    bank: str = Field(min_length=1, max_length=40)
    card_number: str = Field(min_length=16, max_length=19)
    sheba_number: str | None = Field(default=None, min_length=26, max_length=40)
    account_number: str | None = Field(default=None, min_length=1, max_length=50)
    opening_balance: int = Field(default=0, strict=True, ge=-999999999999, le=999999999999)
    active: bool = True

    @model_validator(mode="before")
    @classmethod
    def required_fields(cls, value):
        if isinstance(value, dict):
            for field, label in [("first_name", "نام"), ("last_name", "نام خانوادگی"), ("bank", "بانک"), ("card_number", "شماره کارت")]:
                if value.get(field) is None or isinstance(value.get(field), str) and not value[field].strip():
                    raise ValueError(f"{label} الزامی است.")
        return value

    @field_validator("first_name", "last_name", mode="before")
    @classmethod
    def owner_name(cls, value):
        if not isinstance(value, str):
            return value
        value = normalize_text(value)
        if not value or not any(unicodedata.category(char).startswith("L") for char in value):
            raise ValueError("نام و نام خانوادگی صاحب حساب الزامی است.")
        if any(not (unicodedata.category(char)[0] in "LM" or char in " '-\u200c") for char in value):
            raise ValueError("نام و نام خانوادگی باید فقط شامل حروف باشند و عدد نداشته باشند.")
        return value

    @field_validator("account_number", mode="before")
    @classmethod
    def normalize_account(cls, value):
        return normalize_text(value) or None if isinstance(value, str) else value

    @field_validator("card_number", mode="before")
    @classmethod
    def card(cls, value):
        if not isinstance(value, str):
            raise ValueError("شماره کارت را به صورت ۱۶ رقم وارد کنید.")
        value = re.sub(r"\s", "", value.translate(DIGITS))
        if not re.fullmatch(r"[0-9]{16}", value) or len(set(value)) == 1:
            raise ValueError("شماره کارت باید ۱۶ رقم معتبر باشد.")
        checksum = sum((digit * 2 - 9 if digit * 2 > 9 else digit * 2) if index % 2 == 0 else digit
                       for index, digit in enumerate(map(int, value)))
        if checksum % 10:
            raise ValueError("شماره کارت معتبر نیست؛ ارقام آن را بررسی کنید.")
        return value

    @field_validator("sheba_number", mode="before")
    @classmethod
    def sheba(cls, value):
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("شماره شبا را با IR و ۲۴ رقم وارد کنید.")
        value = re.sub(r"\s", "", value.translate(DIGITS)).upper()
        if not value:
            return None
        if not re.fullmatch(r"IR[0-9]{24}", value):
            raise ValueError("شماره شبا باید شامل IR و ۲۴ رقم باشد.")
        if int(value[4:] + "1827" + value[2:4]) % 97 != 1:
            raise ValueError("شماره شبا معتبر نیست؛ ارقام آن را بررسی کنید.")
        return value


class CategoryWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=150)
    active: bool = True

    @field_validator("title", mode="before")
    @classmethod
    def normalize(cls, value):
        return normalize_text(value) if isinstance(value, str) else value


class TransactionFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    kind: Literal["income", "expense"]
    customer_id: int | None = Field(default=None, strict=True, gt=0)
    expense_category_id: int | None = Field(default=None, strict=True, gt=0)
    bank_id: int = Field(strict=True, gt=0)
    amount: int = Field(strict=True, gt=0, le=999999999999)
    tracking_number: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=5000)
    transaction_date: date
    time_mode: Literal["auto", "manual"] = "auto"
    hour: int | None = Field(default=None, strict=True, ge=0, le=23)
    minute: int | None = Field(default=None, strict=True, ge=0, le=59)

    @field_validator("transaction_date", mode="before")
    @classmethod
    def jalali_date(cls, value):
        return parse_jalali(value)

    @field_validator("description", "tracking_number", mode="before")
    @classmethod
    def optional_text(cls, value):
        return value.strip() or None if isinstance(value, str) else value

    @field_validator("tracking_number")
    @classmethod
    def tracking(cls, value):
        if value is not None:
            value = value.translate(DIGITS)
            if not re.fullmatch(r"[0-9]+", value):
                raise ValueError("شماره پیگیری باید فقط شامل رقم باشد.")
        return value

    @model_validator(mode="after")
    def source_and_time(self):
        if self.kind == "income" and (self.customer_id is None or self.expense_category_id is not None):
            raise ValueError("برای درآمد فقط مشتری را انتخاب کنید.")
        if self.kind == "expense" and (self.expense_category_id is None or self.customer_id is not None):
            raise ValueError("برای هزینه فقط عنوان هزینه را انتخاب کنید.")
        if self.kind == "expense" and self.tracking_number is not None:
            raise ValueError("شماره پیگیری فقط برای درآمد قابل ثبت است.")
        if self.time_mode == "manual" and (self.hour is None or self.minute is None):
            raise ValueError("ساعت و دقیقه را وارد کنید.")
        if self.time_mode == "auto" and (self.hour is not None or self.minute is not None):
            raise ValueError("در حالت اتومات، ساعت و دقیقه توسط سرور تعیین می‌شوند.")
        return self


class TransactionWrite(TransactionFields):
    request_id: UUID


class TransactionEdit(TransactionFields):
    pass


class FinanceDelete(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=1024, repr=False)
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError("برای حذف باید تأیید کنید که مطمئن هستید.")
        return value
