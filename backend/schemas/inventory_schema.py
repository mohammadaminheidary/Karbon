from pydantic import BaseModel, ConfigDict, Field, field_validator
from schemas.customer_schema import normalize_text
from datetime import date
from uuid import UUID
from schemas.finance_schema import parse_jalali
from pydantic import model_validator


class InventoryNameWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name", mode="before")
    @classmethod
    def normalized_name(cls, value):
        return normalize_text(value) if isinstance(value, str) else value


class InventoryOptionWrite(InventoryNameWrite):
    active: bool = Field(default=True, strict=True)


class InventoryCategoryWrite(InventoryOptionWrite):
    parent_id: int | None = Field(default=None, strict=True, gt=0, le=9223372036854775807)


class PurchaseRowWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    category_id: int = Field(strict=True, gt=0, le=9223372036854775807)
    product_id: int = Field(strict=True, gt=0, le=9223372036854775807)
    unit: str | None = Field(default=None, min_length=1, max_length=80)
    quantity: int = Field(strict=True, gt=0, le=1000000)
    purchase_price: int = Field(strict=True, ge=0, le=999999999999)

    @model_validator(mode="after")
    def total(self):
        if self.quantity * self.purchase_price > 999999999999:
            raise ValueError("جمع مبلغ ردیف خرید بیش از حد مجاز است.")
        return self


class PurchaseWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    request_id: UUID
    purchase_date: date
    invoice_number: str | None = Field(default=None, min_length=1, max_length=32)
    invoice_settings_revision: int | None = Field(default=None, strict=True, ge=1)
    supplier_id: int | None = Field(default=None, strict=True, gt=0, le=9223372036854775807)
    rows: list[PurchaseRowWrite] = Field(min_length=1, max_length=100)

    @model_validator(mode="before")
    @classmethod
    def legacy_single_row(cls, value):
        # Preserve pending requests and integrations from the single-item form.
        if isinstance(value, dict) and "rows" not in value:
            value = dict(value)
            fields = {"category_id", "product_id", "unit", "quantity", "purchase_price"}
            value["rows"] = [{key: value.pop(key) for key in fields if key in value}]
        return value

    @field_validator("purchase_date", mode="before")
    @classmethod
    def jalali_date(cls, value):
        return parse_jalali(value)

    @model_validator(mode="after")
    def total(self):
        if sum(row.quantity * row.purchase_price for row in self.rows) > 999999999999:
            raise ValueError("جمع مبلغ خرید بیش از حد مجاز است.")
        return self


class PurchaseEdit(PurchaseWrite):
    revision: int = Field(strict=True, gt=0)
