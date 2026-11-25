"""Template lifecycle, validated image assets and issuance-time presentation."""
from base64 import b64decode, b64encode
from binascii import Error as Base64Error
from hashlib import sha256
from io import BytesIO
from uuid import uuid4

from PIL import Image
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from models.invoice_settings import (
    InvoiceAsset, InvoiceLayoutVersion, InvoiceSequence, InvoiceSettings,
    InvoiceTemplate, InvoiceTemplateDefault,
)
from schemas.invoice_settings_schema import FinancialDefaults, Layout, Numbering, SettingsWrite, Signatures, StoreProfile
from services.finance_service import FinanceError
from services.fiscal_period import year_of
from schemas.customer_schema import normalize_text

SETTINGS_TABLES = [model.__table__ for model in (
    InvoiceSettings, InvoiceAsset, InvoiceTemplate, InvoiceLayoutVersion, InvoiceTemplateDefault, InvoiceSequence,
)]
INVOICE_COLUMNS = {
    "orders": {"tax": "BIGINT NOT NULL DEFAULT 0", "shipping": "BIGINT NOT NULL DEFAULT 0"},
    "purchases": {
        "invoice_snapshot": "JSON", "discount": "BIGINT NOT NULL DEFAULT 0",
        "tax": "BIGINT NOT NULL DEFAULT 0", "shipping": "BIGINT NOT NULL DEFAULT 0",
        "supplier_id": "INTEGER REFERENCES customers(id) ON DELETE RESTRICT",
    },
}
KINDS = {"sale": "فروش", "purchase": "خرید"}
MONEY_LIMIT = 999999999999


class InvoiceConflict(FinanceError):
    def __init__(self, message, code):
        super().__init__(message, 409)
        self.code = code


def default_settings():
    return SettingsWrite(revision=1, store=StoreProfile(), signatures=Signatures(),
                         sale_finance=FinancialDefaults(), purchase_finance=FinancialDefaults(),
                         sale_numbering=Numbering(), purchase_numbering=Numbering()).model_dump(exclude={"revision"})


def default_layout(kind):
    def element(key, name, x, y, w, h, **style):
        return dict(id=key, type=key, name=name, x=x, y=y, w=w, h=h, **style)

    elements = [
        element("title", "عنوان", 0, 0, 75, 13, font_size=23, weight=800, color="#213958", align="left"),
        element("logo", "لوگو", 161, 0, 25, 21, aspect=True),
        element("store_name", "نام فروشگاه", 82, 0, 76, 8, font_size=16, weight=800),
        element("company", "اطلاعات ثبتی", 82, 9, 76, 20, font_size=9),
        element("number", "شماره", 0, 15, 77, 6, align="left"),
        element("date", "تاریخ", 0, 22, 77, 6, align="left"),
        element("due_date", "سررسید", 0, 29, 77, 6, align="left"),
        element("contacts", "راه‌های ارتباطی", 82, 30, 104, 10, font_size=9),
        element("address", "نشانی فروشگاه", 82, 40, 104, 12, font_size=9),
        element("reference", "شماره مرجع", 0, 36, 77, 6, align="left"),
        element("status", "وضعیت", 0, 43, 77, 6, align="left"),
        element("hline", "جداکننده", 0, 53, 186, 2, background="#d8e2ef"),
        element("customer" if kind == "sale" else "supplier", "طرف حساب", 0, 58, 186, 16, weight=600),
        element("table", "اقلام فاکتور", 0, 78, 186, 17, font_size=10),
        element("subtotal", "جمع اقلام", 0, 100, 86, 6, align="left"),
        element("discount", "تخفیف", 0, 107, 86, 6, align="left"),
        element("tax", "مالیات", 0, 114, 86, 6, align="left"),
        element("shipping", "هزینه ارسال", 0, 121, 86, 6, align="left"),
        element("total", "مبلغ نهایی", 0, 128, 86, 12, padding=2, weight=800, font_size=13,
                align="left", background="#e8eff9", color="#213958", radius=2),
        element("amount_words", "مبلغ به حروف", 89, 99, 97, 12, font_size=9),
        element("notes", "یادداشت", 89, 112, 97, 31, font_size=9),
        element("signature", "امضای مشتری", 0, 166, 55, 19, border_width=0.2, padding=2),
        element("seller", "امضای فروشنده", 65, 166, 55, 19),
        element("stamp", "مهر", 131, 166, 55, 19),
    ]
    if kind == "sale":
        elements.extend([
            element("paid", "پرداخت‌شده", 0, 142, 86, 6, align="left"),
            element("remaining", "مانده", 0, 151, 86, 6, weight=700, align="left"),
            element("payments", "روش‌های پرداخت", 89, 144, 97, 15, font_size=9),
        ])
    columns = [
        ("product_name", "نام کالا", 34, "right", True),
        ("product_code", "کد کالا", 11, "center", False),
        ("brand_name", "برند", 10, "center", True),
        ("quantity", "تعداد", 10, "center", True),
        ("unit", "واحد", 10, "center", True),
        ("unit_price", "قیمت واحد", 18, "left", True),
        ("discount", "تخفیف", 12, "left", False),
        ("tax", "مالیات", 12, "left", False),
        ("total", "مبلغ", 18, "left", True),
    ]
    return Layout.model_validate(dict(page={}, table={"columns": [
        dict(key=key, label=label, width=width, align=align, enabled=enabled)
        for key, label, width, align, enabled in columns
    ]}, elements=elements)).model_dump()


def initialize_invoice_storage(engine):
    """Idempotent startup and online-restore migration for existing SQLite files."""
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        for table, additions in INVOICE_COLUMNS.items():
            existing = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({table})")}
            if existing:
                for name, definition in additions.items():
                    if name not in existing:
                        connection.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
        connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_purchases_supplier_id ON purchases(supplier_id)")
        connection.exec_driver_sql("DROP TRIGGER IF EXISTS permanent_purchase_invoice")
        connection.exec_driver_sql("""CREATE TRIGGER IF NOT EXISTS purchase_invoice_revision_guard
            BEFORE UPDATE OF invoice_number, invoice_snapshot ON purchases
            WHEN NEW.invoice_number IS NOT OLD.invoice_number OR
                 (OLD.invoice_snapshot IS NOT NULL AND OLD.invoice_snapshot != 'null'
                  AND NEW.invoice_snapshot IS NOT OLD.invoice_snapshot
                  AND (NEW.revision != OLD.revision + 1 OR NEW.last_edit_id IS NULL
                       OR NEW.last_edit_id IS OLD.last_edit_id))
            BEGIN SELECT RAISE(ABORT, 'purchase invoice is permanent'); END""")
        with Session(bind=connection) as db:
            if db.get(InvoiceSettings, 1) is None:
                db.add(InvoiceSettings(id=1, revision=1, data={**default_settings(), "scope": uuid4().hex}))
            for kind, name in KINDS.items():
                if db.get(InvoiceTemplateDefault, kind) is None:
                    template = add_template(db, kind, f"قالب استاندارد {name}", default_layout(kind))
                    db.add(InvoiceTemplateDefault(kind=kind, template_id=template.id))
            db.flush()


def begin_write(db):
    db.rollback()
    db.execute(text("BEGIN IMMEDIATE"))


def preferences(db):
    return db.get(InvoiceSettings, 1)


def settings_data(db, editable):
    settings = preferences(db)
    defaults = {value.kind: value.template_id for value in db.scalars(select(InvoiceTemplateDefault))}
    return {
        **settings.data, "revision": settings.revision, "editable": editable,
        "templates": [template_data(row, default=defaults[row.kind] == row.id)
                      for row in db.scalars(select(InvoiceTemplate).order_by(InvoiceTemplate.id))],
    }


def update_settings(db, settings):
    begin_write(db)
    row = preferences(db)
    check_revision(row, settings.revision)
    keys = [settings.store.logo, settings.signatures.seller_image, settings.signatures.stamp_image]
    if any(key and db.get(InvoiceAsset, key) is None for key in keys):
        raise FinanceError("فایل تصویری انتخاب‌شده پیدا نشد.", 422)
    row.data = {**settings.model_dump(exclude={"revision"}), "scope": row.data.get("scope") or uuid4().hex}
    row.revision += 1
    response = {"revision": row.revision, **row.data}
    db.commit()
    return response


def save_asset(db, data):
    try:
        raw = b64decode(data, validate=True)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError
        with Image.open(BytesIO(raw), formats=["PNG", "JPEG", "WEBP"]) as picture:
            mime = Image.MIME[picture.format]
            if picture.width * picture.height > 12_000_000 or getattr(picture, "is_animated", False):
                raise ValueError
            picture.verify()
        with Image.open(BytesIO(raw), formats=["PNG", "JPEG", "WEBP"]) as picture:
            picture.load()
    except (Base64Error, KeyError, ValueError, OSError, SyntaxError, Image.DecompressionBombError) as error:
        raise FinanceError("یک تصویر ثابت PNG، JPEG یا WebP سالم تا 2 مگابایت انتخاب کنید.", 422) from error
    key = sha256(raw).hexdigest()
    begin_write(db)
    if db.get(InvoiceAsset, key) is None:
        db.add(InvoiceAsset(id=key, mime=mime, content=raw))
    db.commit()
    return {"id": key, "mime": mime}


def asset_urls(db, store, signatures):
    refs = {"logo": store.get("logo"), "seller": signatures.get("seller_image"), "stamp": signatures.get("stamp_image")}
    keys = {key for key in refs.values() if key}
    assets = {asset.id: asset for asset in db.scalars(select(InvoiceAsset).where(InvoiceAsset.id.in_(keys)))} if keys else {}
    return {name: f"data:{assets[key].mime};base64,{b64encode(assets[key].content).decode('ascii')}"
            for name, key in refs.items() if key in assets}


def check_revision(row, revision):
    if row.revision != revision:
        raise FinanceError("تغییر جدیدتری ذخیره شده است. نسخه ذخیره‌شده را دوباره باز کنید.", 409)


def template_row(db, key):
    row = db.get(InvoiceTemplate, key)
    if row is None:
        raise FinanceError("قالب فاکتور پیدا نشد.", 404)
    return row


def current_version(db, row):
    return db.scalar(select(InvoiceLayoutVersion).where(
        InvoiceLayoutVersion.template_id == row.id, InvoiceLayoutVersion.revision == row.revision))


def validated_layout(version, kind):
    if version is not None:
        try:
            return Layout.model_validate(version.layout).model_dump()
        except ValidationError:
            pass
    return default_layout(kind)


def template_data(row, **details):
    return {"id": row.id, "kind": row.kind, "name": row.name, "revision": row.revision, **details}


def read_template(db, key):
    row = template_row(db, key)
    return template_data(row, layout=validated_layout(current_version(db, row), row.kind))


def add_template(db, kind, name, layout):
    if db.scalar(select(InvoiceTemplate.id).where(InvoiceTemplate.kind == kind, InvoiceTemplate.name == name)):
        raise FinanceError("نام قالب در این نوع فاکتور تکراری است.", 409)
    row = InvoiceTemplate(kind=kind, name=name, revision=1)
    db.add(row)
    db.flush()
    db.add(InvoiceLayoutVersion(template_id=row.id, revision=row.revision, layout=layout))
    return row


def create_template(db, data):
    begin_write(db)
    layout = read_template(db, data.copy_from)["layout"] if data.copy_from else default_layout(data.kind)
    row = add_template(db, data.kind, data.name, layout)
    result = template_data(row, layout=layout)
    db.commit()
    return result


def update_template(db, key, data):
    begin_write(db)
    row = template_row(db, key)
    check_revision(row, data.revision)
    conflict = db.scalar(select(InvoiceTemplate.id).where(InvoiceTemplate.kind == row.kind,
                         InvoiceTemplate.name == data.name, InvoiceTemplate.id != key))
    if conflict:
        raise FinanceError("نام قالب در این نوع فاکتور تکراری است.", 409)
    layout = data.layout.model_dump()
    if row.name != data.name or validated_layout(current_version(db, row), row.kind) != layout:
        row.name = data.name
        row.revision += 1
        db.add(InvoiceLayoutVersion(template_id=row.id, revision=row.revision, layout=layout))
    result = template_data(row, layout=layout)
    db.commit()
    return result


def set_default(db, key):
    begin_write(db)
    row = template_row(db, key)
    db.get(InvoiceTemplateDefault, row.kind).template_id = row.id
    db.commit()


def delete_template(db, key, revision):
    begin_write(db)
    row = template_row(db, key)
    check_revision(row, revision)
    if db.get(InvoiceTemplateDefault, row.kind).template_id == key:
        raise FinanceError("پیش از حذف، قالب دیگری را برای این نوع پیش‌فرض کنید.", 409)
    db.delete(row)
    db.commit()


def freeze_presentation(db, kind, settings):
    default = db.get(InvoiceTemplateDefault, kind)
    row = db.get(InvoiceTemplate, default.template_id)
    version = current_version(db, row)
    return {
        "kind": kind, "layout_version": version.id if version else None,
        "store": settings["store"], "signatures": settings["signatures"],
        "finance": {key: settings[f"{kind}_finance"][key] for key in
                    ("currency", "symbol", "precision", "tax_display", "amount_words")},
    }


def with_presentation(db, invoice):
    saved = invoice.get("presentation")
    if not saved:
        return invoice
    version = db.get(InvoiceLayoutVersion, saved["layout_version"]) if saved["layout_version"] else None
    return {**invoice, "store": saved["store"], "presentation": {
        **saved, "layout": validated_layout(version, saved["kind"]),
        "images": asset_urls(db, saved["store"], saved["signatures"]),
    }}


def calculate_totals(subtotal, defaults, discount=None):
    """All amounts are whole toman. Percentages use basis points and round half up."""
    def percent(amount, rate):
        return (amount * rate + 5000) // 10000

    if discount is None:
        value = defaults["discount_value"]
        discount = percent(subtotal, value) if defaults["discount_kind"] == "percent" else min(value, subtotal)
    if not 0 <= discount <= subtotal <= MONEY_LIMIT:
        raise FinanceError("جمع اقلام یا تخفیف فاکتور معتبر نیست.", 422)
    tax = percent(subtotal - discount, defaults["tax_rate"]) if defaults["tax_enabled"] else 0
    shipping = defaults["shipping"]
    total = subtotal - discount + tax + shipping
    if total > MONEY_LIMIT:
        raise FinanceError("جمع مبلغ فاکتور از حد مجاز بیشتر است.", 422)
    return dict(subtotal=subtotal, discount=discount, tax=tax, shipping=shipping, total=total)


def allocate_number(db, kind, config, day, manual, column, legacy):
    """Called while the issuance transaction holds SQLite's write lock."""
    def exists(value):
        return db.scalar(select(column).where(column == value).limit(1)) is not None

    if manual is not None:
        if not allows_manual(config):
            raise FinanceError("شماره‌گذاری دستی برای این نوع فاکتور فعال نیست.", 422)
        value = normalize_text(manual)
        if not value or len(value) > 32 or not value.isprintable() or value.casefold().startswith("pending-"):
            raise FinanceError("شماره فاکتور معتبر نیست.", 422)
        if exists(value):
            raise InvoiceConflict("شماره فاکتور تکراری است.", "INVOICE_NUMBER_TAKEN")
        return value
    if config["mode"] == "manual":
        raise FinanceError("شماره فاکتور را وارد کنید.", 422)
    if config["mode"] == "legacy":
        number = legacy()
        candidate = number
        index = 1
        while exists(candidate):
            candidate = f"{number}-{index}"
            index += 1
        return candidate
    year = int(year_of(day)) if config["yearly"] else 0
    series = db.get(InvoiceSequence, (kind, year))
    value = max(config["start"], series.next_value) if series else config["start"]
    period = f"{year}-" if year else ""
    while value <= 9999999999:
        number = f"{normalize_text(config['prefix'])}{period}{value:0{config['digits']}d}{normalize_text(config['suffix'])}"
        if not exists(number):
            if series is None:
                db.add(InvoiceSequence(kind=kind, year=year, next_value=value + 1))
            else:
                series.next_value = value + 1
            return number
        value += 1
    raise FinanceError("ظرفیت شماره‌گذاری فاکتور پایان یافته است.", 409)


def allows_manual(config):
    return config["mode"] == "manual" or config["allow_manual"]


def workflow_settings(db, kind):
    settings = preferences(db)
    numbering = settings.data[f"{kind}_numbering"]
    return {"revision": settings.revision, "finance": settings.data[f"{kind}_finance"],
            "numbering": {"manual": allows_manual(numbering), "required": numbering["mode"] == "manual",
                          "legacy": numbering["mode"] == "legacy"}}


def check_workflow_revision(settings, revision):
    if revision is not None and revision != settings.revision:
        raise InvoiceConflict("تنظیمات فاکتور تغییر کرده است. تنظیمات فرم بروزرسانی می‌شود.", "INVOICE_SETTINGS_CHANGED")


def party_data(customer):
    if customer is None:
        return None
    return {"code": customer.customer_code, "name": f"{customer.first_name} {customer.last_name}",
            "phone_numbers": list(customer.phone_numbers), "address": customer.address}
