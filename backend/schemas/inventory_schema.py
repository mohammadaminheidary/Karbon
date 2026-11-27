from pydantic import BaseModel, ConfigDict, Field, field_validator
from schemas.customer_schema import normalize_text
from datetime import date
from typing import Annotated
from uuid import UUID
from schemas.finance_schema import FinanceDelete, parse_jalali
from schemas.order_schema import SettlementWrite
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


class WarehouseProductsDelete(FinanceDelete):
    product_ids: list[Annotated[int, Field(strict=True, gt=0, le=9223372036854775807)]] = Field(min_length=1)


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


class PurchasePaymentWrite(SettlementWrite):
    @model_validator(mode="after")
    def source(self):
        if self.method == "cash" and self.bank_id is not None:
            raise ValueError("پرداخت نقدی فقط از صندوق نقدی ثبت می‌شود.")
        if self.method != "cash" and self.bank_id is None:
            raise ValueError("حساب بانکی مبدأ پرداخت را انتخاب کنید.")
        return self


class PurchasePaymentEdit(PurchasePaymentWrite):
    revision: int = Field(strict=True, gt=0)


class PurchaseWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    request_id: UUID
    catalog_only: bool = Field(default=False, strict=True)
    purchase_date: date
    invoice_number: str | None = Field(default=None, min_length=1, max_length=32)
    invoice_settings_revision: int | None = Field(default=None, strict=True, ge=1)
    supplier_id: int | None = Field(default=None, strict=True, gt=0, le=9223372036854775807)
    description: str | None = Field(default=None, max_length=1000)
    discount: int | None = Field(default=None, strict=True, ge=0, le=999999999999)
    payments: list[PurchasePaymentWrite] = Field(default_factory=list, max_length=100)
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
        if len({payment.request_id for payment in self.payments}) != len(self.payments):
            raise ValueError("شناسه درخواست پرداخت‌ها باید متفاوت باشد.")
        return self


class PurchaseEdit(PurchaseWrite):
    revision: int = Field(strict=True, gt=0)
