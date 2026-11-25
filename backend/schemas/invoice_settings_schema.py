"""Versioned invoice presentation and issuance settings."""
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, model_validator

from schemas.order_schema import StrictFields

InvoiceKind = Literal["sale", "purchase"]
AssetKey = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
Color = Annotated[str, StringConstraints(pattern=r"^#[0-9a-fA-F]{6}$")]
ShortText = Annotated[str, StringConstraints(max_length=180)]
Alignment = Literal["left", "center", "right"]
ColumnKey = Literal["product_name", "product_code", "brand_name", "quantity", "unit",
                    "unit_price", "discount", "tax", "total"]
ElementKind = Literal[
    "logo", "store_name", "company", "address", "contacts", "title", "number", "date",
    "due_date", "status", "reference", "customer", "supplier", "party_contact",
    "billing_address", "delivery_address", "table", "subtotal", "discount", "tax",
    "shipping", "total", "amount_words", "currency", "seller", "signature", "stamp",
    "text", "notes", "hline", "vline", "rectangle", "ellipse", "payments", "paid", "remaining",
]

PAPER = {"A4": (210, 297), "A5": (148, 210), "Letter": (215.9, 279.4), "Legal": (215.9, 355.6)}


class StoreProfile(StrictFields):
    name: ShortText = ""
    legal_name: ShortText = ""
    registration: ShortText = ""
    national_id: ShortText = ""
    tax_id: ShortText = ""
    phone: ShortText = ""
    mobile: ShortText = ""
    email: ShortText = ""
    website: ShortText = ""
    address: str = Field(default="", max_length=700)
    postal_code: ShortText = ""
    slogan: str = Field(default="", max_length=350)
    logo: AssetKey | None = None


class Signatures(StrictFields):
    seller_image: AssetKey | None = None
    stamp_image: AssetKey | None = None
    seller_label: ShortText = "امضای فروشنده"
    customer_label: ShortText = "امضای مشتری"
    stamp_label: ShortText = "مهر شرکت"
    seller_enabled: bool = False
    customer_enabled: bool = False
    stamp_enabled: bool = False


class FinancialDefaults(StrictFields):
    currency: Literal["IRT", "IRR"] = "IRT"
    symbol: str = Field(default="", max_length=30)
    precision: int = Field(default=0, ge=0, le=4)
    tax_enabled: bool = False
    tax_rate: int = Field(default=0, ge=0, le=10000)
    tax_display: Literal["separate", "included", "hidden"] = "separate"
    discount_kind: Literal["fixed", "percent"] = "fixed"
    discount_value: int = Field(default=0, ge=0, le=999999999999)
    shipping: int = Field(default=0, ge=0, le=999999999999)
    amount_words: bool = False

    @model_validator(mode="after")
    def check_discount(self):
        if self.discount_kind == "percent" and self.discount_value > 10000:
            raise ValueError("درصد تخفیف نمی‌تواند بیشتر از 100 باشد.")
        return self


class Numbering(StrictFields):
    mode: Literal["legacy", "automatic", "manual"] = "legacy"
    prefix: str = Field(default="", max_length=8, pattern=r"^[\w./-]*$")
    suffix: str = Field(default="", max_length=8, pattern=r"^[\w./-]*$")
    start: int = Field(default=1, ge=1, le=9999999999)
    digits: int = Field(default=5, ge=1, le=10)
    yearly: bool = False
    allow_manual: bool = False


class SettingsWrite(StrictFields):
    revision: int = Field(ge=1)
    store: StoreProfile
    signatures: Signatures
    sale_finance: FinancialDefaults
    purchase_finance: FinancialDefaults
    sale_numbering: Numbering
    purchase_numbering: Numbering


class AssetUpload(StrictFields):
    data: str = Field(min_length=4, max_length=2796204)


class Element(StrictFields):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    type: ElementKind
    name: ShortText = ""
    text: str = Field(default="", max_length=5000)
    x: float = Field(ge=0, le=360)
    y: float = Field(ge=0, le=360)
    w: float = Field(ge=2, le=360)
    h: float = Field(ge=2, le=360)
    rotation: float = Field(default=0, ge=-180, le=180)
    aspect: bool = False
    locked: bool = False
    visible: bool = True
    group: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    font: Literal["Vazirmatn", "Arial", "Tahoma", "Georgia"] = "Vazirmatn"
    font_size: float = Field(default=11, ge=5, le=60)
    weight: Literal[400, 500, 600, 700, 800, 900] = 400
    color: Color = "#17253a"
    align: Alignment = "right"
    line_height: float = Field(default=1.5, ge=0.8, le=3)
    spacing: float = Field(default=0, ge=-2, le=8)
    background: Color | Literal["transparent"] = "transparent"
    border: Color = "#cbd5e1"
    border_width: float = Field(default=0, ge=0, le=8)
    radius: float = Field(default=0, ge=0, le=40)
    opacity: float = Field(default=1, ge=0, le=1)
    padding: float = Field(default=0, ge=0, le=12)


class TableColumn(StrictFields):
    key: ColumnKey
    label: ShortText
    enabled: bool = True
    width: float = Field(default=10, ge=1, le=100)
    align: Alignment = "center"


class Table(StrictFields):
    columns: list[TableColumn] = Field(min_length=1, max_length=9)
    row_height: float = Field(default=8, ge=3, le=35)
    cell_padding: float = Field(default=1.2, ge=0, le=8)
    border: Color = "#d8e2ef"
    border_width: float = Field(default=0.2, ge=0, le=3)
    background: Color = "#ffffff"
    header_background: Color = "#213958"
    header_color: Color = "#ffffff"
    header_font: Literal["Vazirmatn", "Arial", "Tahoma", "Georgia"] = "Vazirmatn"
    header_size: float = Field(default=10, ge=5, le=35)
    alternate: bool = True
    alternate_background: Color = "#f1f6fc"
    repeat_header: bool = True

    @model_validator(mode="after")
    def check_columns(self):
        if len({c.key for c in self.columns}) != len(self.columns) or not any(c.enabled for c in self.columns):
            raise ValueError("ستون‌ها باید یکتا باشند و حداقل یک ستون فعال باشد.")
        return self


class Page(StrictFields):
    paper: Literal["A4", "A5", "Letter", "Legal"] = "A4"
    orientation: Literal["portrait", "landscape"] = "portrait"
    top: float = Field(default=12, ge=3, le=35)
    right: float = Field(default=12, ge=3, le=35)
    bottom: float = Field(default=12, ge=3, le=35)
    left: float = Field(default=12, ge=3, le=35)
    scale: int = Field(default=100, ge=50, le=150)
    header: ShortText = ""
    footer: ShortText = ""
    page_numbers: bool = True
    print_colors: bool = True

    def size(self):
        width, height = PAPER[self.paper]
        return (height, width) if self.orientation == "landscape" else (width, height)


class Layout(StrictFields):
    version: Literal[1] = 1
    page: Page
    table: Table
    elements: list[Element] = Field(max_length=100)

    @model_validator(mode="after")
    def check_elements(self):
        if len({item.id for item in self.elements}) != len(self.elements):
            raise ValueError("شناسه لایه‌ها باید یکتا باشد.")
        if sum(item.type == "table" for item in self.elements) > 1:
            raise ValueError("هر قالب یک جدول اقلام دارد.")
        width, height = self.page.size()
        for item in self.elements:
            if item.x + item.w > width - self.page.left - self.page.right + 0.02 or item.y + item.h > height - self.page.top - self.page.bottom + 0.02:
                raise ValueError(f"لایه «{item.name or item.id}» بیرون از محدوده صفحه است.")
            if item.type == "table" and item.rotation:
                raise ValueError("چرخش جدول اقلام مجاز نیست.")
        return self


class TemplateCreate(StrictFields):
    kind: InvoiceKind
    name: str = Field(min_length=1, max_length=100)
    copy_from: int | None = Field(default=None, gt=0)


class TemplateWrite(StrictFields):
    revision: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=100)
    layout: Layout
