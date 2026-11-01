"""Read-only reporting over an explicit set of business tables.

Columns and joins are reflected from the connected database, not a parallel
schema. No authentication or biometric tables can enter this catalog.
"""
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from functools import lru_cache
import json

from fastapi import HTTPException
from sqlalchemy import (MetaData, Table, select, func, or_, cast, String,
                        Date, DateTime, Time, Boolean, Integer, Numeric, JSON)

TABLES = {
    "customers": "مشتریان", "orders": "سفارش‌ها", "order_items": "اقلام سفارش",
    "order_payments": "پرداخت‌های سفارش", "financial_transactions": "تراکنش‌های مالی",
    "bank_accounts": "حساب‌های بانکی", "bank_directory": "فهرست بانک‌ها",
    "expense_categories": "دسته‌بندی هزینه‌ها", "products": "کالاها و موجودی",
    "inventory_options": "دسته‌بندی‌ها و واحدهای انبار", "documents": "اسناد",
    "document_accounts": "حساب‌های اسناد", "members": "اعضا",
    "attendance": "حضور و غیاب", "tasks": "کارهای روزانه",
}
# Labels only. This map never declares or adds a column.
LABELS = dict(
    id="شناسه", customer_code="کد مشتری", permanent_id="شناسه دائمی", gender="جنسیت",
    first_name="نام", last_name="نام خانوادگی", address="نشانی", last_contact_date="آخرین تماس",
    phone_numbers="شماره‌های تماس", notes="یادداشت", created_at="زمان ایجاد", updated_at="زمان ویرایش",
    deleted_at="زمان حذف", request_id="شناسه درخواست", request_fingerprint="اثر انگشت درخواست",
    invoice_code="کد فاکتور", order_number="شماره سفارش", customer_id="شناسه مشتری",
    invoice_date="تاریخ فاکتور", payment_date="تاریخ پرداخت", description="شرح", subtotal="جمع جزء",
    discount="تخفیف", status="وضعیت", invoice_snapshot="اطلاعات ثبت‌شده فاکتور", revision="نسخه",
    order_id="شناسه سفارش", product_id="شناسه کالا", position="ترتیب", product_name="نام کالا",
    unit="واحد", quantity="تعداد", unit_price="قیمت واحد", transaction_id="شناسه تراکنش",
    method="روش پرداخت", code="کد", name="نام", logo_url="نشانی نشان", active="فعال",
    account_number="شماره حساب", opening_balance="مانده افتتاحیه", bank="بانک", card_number="شماره کارت",
    sheba_number="شماره شبا", title="عنوان", display_code="کد نمایشی", transaction_number="شماره تراکنش",
    kind="نوع", expense_category_id="شناسه دسته هزینه", bank_id="شناسه حساب بانکی",
    document_id="شناسه سند", document_account_id="شناسه حساب سند", account_code="کد حساب",
    amount="مبلغ", tracking_number="شماره پیگیری", transaction_date="تاریخ تراکنش",
    transaction_time="ساعت تراکنش", time_mode="روش ثبت ساعت", product_code="کد کالا", price="قیمت",
    stock="موجودی", number="شماره", date="تاریخ", document_type="نوع سند", last_request_id="شناسه آخرین درخواست",
    phone="تلفن", national_id="کد ملی", member_id="شناسه عضو", recorded_time="ساعت ثبت",
)


def fail(message):
    raise HTTPException(422, message)


def scalar(value):
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    return value


def canonical(value):
    return json.dumps(value, ensure_ascii=False, default=scalar, separators=(",", ":"), allow_nan=False)


def type_name(column):
    t = column.type
    if isinstance(t, DateTime): return "datetime"
    if isinstance(t, Date): return "date"
    if isinstance(t, Time): return "time"
    if isinstance(t, Boolean): return "boolean"
    if isinstance(t, Integer): return "integer"
    if isinstance(t, Numeric): return "number"
    if isinstance(t, JSON): return "json"
    return "text"


@dataclass
class Dataset:
    table: Table
    source: object
    columns: dict
    descriptors: list


@lru_cache(maxsize=8)
def catalog(engine):
    metadata = MetaData()
    # Resolve FKs only inside our allowlist. Never reflect unrelated private tables.
    metadata.reflect(bind=engine, only=lambda name, _: name in TABLES)
    result = {}
    for name, title in TABLES.items():
        if name not in metadata.tables:
            continue
        table = metadata.tables[name]
        source, columns, descriptors = table, {}, []
        def add(key, col, label, foreign_key=None):
            columns[key] = col
            descriptors.append(dict(name=key, label=label, type=type_name(col),
                                    database_type=str(col.type), nullable=col.nullable,
                                    foreign_key=foreign_key, related="." in key))
        for col in table.c:
            fk = next(iter(col.foreign_keys), None)
            add(col.name, col, LABELS.get(col.name, col.name),
                str(fk.target_fullname) if fk else None)
        for fk in sorted(table.foreign_keys, key=lambda item: item.parent.name):
            target = fk.column.table
            if target.name not in TABLES or target is table:
                continue
            alias = target.alias(f"related_{fk.parent.name}")
            source = source.outerjoin(alias, fk.parent == alias.c[fk.column.name])
            for col in alias.c:
                add(f"{fk.parent.name}.{col.name}", col,
                    f"{LABELS.get(fk.parent.name, fk.parent.name)} · {LABELS.get(col.name, col.name)}")
        result[name] = Dataset(table, source, columns, descriptors)
    return result


def dataset(db, name):
    value = catalog(db.get_bind()).get(name)
    if value is None:
        raise HTTPException(404, "گزارش درخواستی وجود ندارد.")
    return value


def schema(db, name):
    ds = dataset(db, name)
    return dict(name=name, title=TABLES[name], columns=ds.descriptors,
                primary_key=next(iter(ds.table.primary_key)).name,
                supports_deleted="deleted_at" in ds.table.c)


def typed(column, value):
    kind = type_name(column)
    try:
        if value is None: return None
        if kind in {"date", "datetime"}:
            text = str(value)
            if kind == "datetime":
                text = text.replace(" ", "T", 1)
            day, sep, clock = text.partition("T")
            if "/" in day:
                import jdatetime
                year, month, number = map(int, day.split("/"))
                day = jdatetime.date(year, month, number).togregorian().isoformat()
            if kind == "date": return date.fromisoformat(day)
            return datetime.fromisoformat(day + ("T" + clock if sep else "T00:00:00"))
        if kind == "time": return time.fromisoformat(str(value))
        if kind == "boolean":
            if type(value) is not bool: raise ValueError()
            return value
        if kind == "integer":
            if isinstance(value, bool) or str(int(value)) != str(value): raise ValueError()
            return int(value)
        if kind == "number":
            from decimal import Decimal
            return Decimal(str(value))
        if kind == "json": fail("فیلتر برابری برای داده ساختاریافته پشتیبانی نمی‌شود.")
        if not isinstance(value, str): raise ValueError()
        return value
    except (ValueError, TypeError, OverflowError):
        fail(f"مقدار فیلتر {column.name} معتبر نیست.")


def conditions(ds, request):
    clauses = []
    if "deleted_at" in ds.table.c and not request.include_deleted:
        clauses.append(ds.table.c.deleted_at.is_(None))
    if request.search:
        # Treat wildcard characters literally, and never interpolate SQL identifiers.
        clauses.append(or_(*(cast(c, String).contains(request.search, autoescape=True)
                            for c in ds.table.c if type_name(c) in {"text", "integer"})))
    for f in request.filters:
        col = ds.columns.get(f.field)
        if col is None: fail("ستون فیلتر معتبر نیست.")
        if f.op == "is_null":
            clauses.append(col.is_(None))
        elif f.op == "eq":
            clauses.append(col == typed(col, f.value))
        else:
            if type_name(col) not in {"date", "datetime", "time", "integer", "number"}:
                fail("بازه برای این ستون معتبر نیست.")
            if f.value is None: fail("مقدار بازه الزامی است.")
            v = typed(col, f.value)
            clauses.append(col >= v if f.op == "gte" else col <= v)
    bounds = {}
    for f in request.filters:
        if f.op in {"gte", "lte"}:
            bounds.setdefault(f.field, {})[f.op] = typed(ds.columns[f.field], f.value)
    for bound in bounds.values():
        if "gte" in bound and "lte" in bound and bound["gte"] > bound["lte"]:
            fail("ابتدای بازه نباید بعد از انتهای آن باشد.")
    pk = next(iter(ds.table.primary_key))
    if request.ids is not None:
        # SQLite's variable limit varies by deployment. JSON binds one parameter.
        ids = select(func.json_each(canonical(request.ids)).table_valued("value").c.value)
        clauses.append(pk.in_(ids))
    if request.excluded_ids:
        ids = select(func.json_each(canonical(request.excluded_ids)).table_valued("value").c.value)
        clauses.append(pk.not_in(ids))
    return clauses


def selected(ds, request):
    names = request.columns if request.columns is not None else [c.name for c in ds.table.c]
    if not names or len(set(names)) != len(names) or any(n not in ds.columns for n in names):
        fail("ستون‌های انتخاب‌شده معتبر نیستند.")
    return names


def query(ds, request, names):
    return select(*(ds.columns[n].label(n) for n in names)).select_from(ds.source).where(
        *conditions(ds, request)).order_by(*ds.table.primary_key)


def snapshot(db):
    # sqlite3's legacy transaction mode does not BEGIN on SELECT. Bind count and
    # rows to the same read snapshot without altering the connection globally.
    connection = db.connection()
    if connection.dialect.name == "sqlite" and not connection.connection.driver_connection.in_transaction:
        connection.exec_driver_sql("BEGIN")


def preview(db, name, request):
    ds = dataset(db, name)
    names = selected(ds, request)
    pk = next(iter(ds.table.primary_key)).name
    # The PK is returned separately for selection even when its column is hidden.
    fetch_names = list(dict.fromkeys([pk, *names]))
    snapshot(db)
    total = db.scalar(select(func.count()).select_from(ds.source).where(*conditions(ds, request)))
    rows = db.execute(query(ds, request, fetch_names).offset(request.offset).limit(request.limit)).mappings()
    def safe(v):
        # JS cannot represent 64-bit integers exactly; retain their decimal representation.
        if isinstance(v, int) and abs(v) > 9007199254740991: return str(v)
        return scalar(v)
    return dict(total=total, columns=names, items=[dict(id=safe(r[pk]), values={n: safe(r[n]) for n in names}) for r in rows])


def options(db, name, field, search="", offset=0):
    ds = dataset(db, name)
    col = ds.columns.get(field)
    if col is None or type_name(col) == "json": fail("ستون گزینه‌ها معتبر نیست.")
    # Offer human-readable FK labels using only columns that reflection found.
    related = [ds.columns[f"{field}.{n}"] for n in ("first_name", "last_name", "name", "title", "number", "invoice_code")
               if f"{field}.{n}" in ds.columns]
    clauses = [col.is_not(None)]
    if search:
        clauses.append(or_(*(cast(c, String).contains(search, autoescape=True) for c in [col, *related])))
    values = db.execute(select(col, *related).select_from(ds.source).where(*clauses).distinct().order_by(col).offset(offset).limit(101)).all()
    return dict(values=[scalar(v[0]) for v in values[:100]], has_more=len(values)>100,
                choices=[dict(value=scalar(v[0]), label=" · ".join(str(scalar(x)) for x in v if x is not None)) for v in values[:100]])
