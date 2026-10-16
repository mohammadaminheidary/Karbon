from datetime import date as Date, datetime
from uuid import UUID
from typing import Literal

import jdatetime
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from schemas.customer_schema import DIGITS, normalize_text
from schemas.finance_schema import TransactionLine, parse_jalali


class DocumentRow(TransactionLine):
    id: int | None = Field(default=None, strict=True, gt=0)
    document_account_id: int = Field(strict=True, gt=0)
    customer_id: None = None
    expense_category_id: None = None


class DocumentAccountWrite(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    title: str = Field(min_length=1, max_length=201)
    kind: Literal["income", "expense"]
    active: bool = True

    @field_validator("title", mode="before")
    @classmethod
    def normalize_fields(cls, value):
        return normalize_text(value) if isinstance(value, str) else value


class DocumentCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    request_id: UUID
    date: Date
    description: str = Field(default="", max_length=5000)
    rows: list[DocumentRow] = Field(min_length=1, max_length=100)
    revision: int | None = Field(default=None, strict=True, ge=1)

    @field_validator("description", mode="before")
    @classmethod
    def normalize_description(cls, value):
        return value.translate(DIGITS).replace("ي", "ی").replace("ك", "ک").strip() if isinstance(value, str) else value

    @field_validator("date", mode="before")
    @classmethod
    def document_date(cls, value):
        return parse_jalali(value) if isinstance(value, str) and "/" in value else value

    @model_validator(mode="after")
    def distinct_rows(self):
        try:
            jdatetime.date.fromgregorian(date=self.date)
        except (ValueError, OverflowError):
            raise ValueError("تاریخ سند در محدوده تقویم شمسی نیست.") from None
        ids = [row.id for row in self.rows if row.id is not None]
        if len(ids) != len(set(ids)):
            raise ValueError("ردیف تکراری در سند مجاز نیست.")
        return self


class DocumentSummary(BaseModel):
    id: int
    number: str
    description: str
    date: Date
    document_type: str
    created_at: datetime
    revision: int
    total_income: int
    total_expense: int
    row_count: int


class DocumentResponse(DocumentSummary):
    rows: list[dict]


class DocumentList(BaseModel):
    items: list[DocumentSummary]
    total: int
    filtered_total: int
    document_types: list[str]
    available_dates: list[Date]
