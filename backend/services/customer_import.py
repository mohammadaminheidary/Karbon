"""Validate and import customer rows from a bounded Excel workbook."""
from contextlib import closing, contextmanager
from datetime import datetime
from io import BytesIO
import re
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile, ZipFile
from zlib import error as ZipDataError

from pydantic import ValidationError
from sqlalchemy import text

from schemas.customer_schema import CustomerWrite, DIGITS, normalize_text
from services import customer_service

MAX_BYTES = 8 * 1024 * 1024
MAX_EXPANDED_BYTES = 48 * 1024 * 1024
MAX_SHEETS = 32
MAX_ROWS = 5000
MAX_COLUMNS = 64
PREVIEW_ROWS = 10
MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

FIELDS = {
    "first_name": ("نام", "first name", "firstname", "given name", "نام کوچک"),
    "last_name": ("نام خانوادگی", "last name", "lastname", "surname", "family name", "فامیل"),
    "phone_numbers": ("شماره تلفن", "phone", "phone number", "phone numbers", "mobile", "mobile number",
                      "telephone", "tel", "cell phone", "شماره تماس", "موبایل", "شماره موبایل", "تلفن", "همراه", "تلفن همراه"),
    "gender": ("جنسیت", "gender", "sex"),
    "address": ("آدرس", "address", "نشانی"),
    "last_contact_date": ("تاریخ آخرین تماس", "last contact date", "last contact", "آخرین تماس"),
    "notes": ("یادداشت", "notes", "note", "description", "توضیحات"),
}
REQUIRED_FIELDS = {name for name in FIELDS if CustomerWrite.model_fields[name].is_required()}
GENDERS = {"مرد": "male", "آقا": "male", "male": "male", "m": "male",
           "زن": "female", "خانم": "female", "female": "female", "f": "female"}


class InvalidWorkbook(Exception):
    pass


@contextmanager
def open_workbook(source):
    from openpyxl import load_workbook
    from openpyxl.utils.exceptions import InvalidFileException

    try:
        with ZipFile(source) as archive:
            entries = archive.infolist()
            if len(entries) > 1024 or sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES:
                raise InvalidWorkbook("حجم بازشده فایل اکسل بیش از حد مجاز است.")
            # XLSX parts do not require DTDs. Reject them before handing XML
            # to the parser, including declarations in UTF-16/32 parts.
            for entry in entries:
                if b"<!DOCTYPE" in archive.read(entry).replace(b"\0", b""):
                    raise InvalidWorkbook("ساختار XML فایل اکسل قابل پردازش نیست.")
        source.seek(0)
        with closing(load_workbook(source, read_only=True, data_only=False, keep_links=False)) as workbook:
            if not 1 <= len(workbook.worksheets) <= MAX_SHEETS:
                raise InvalidWorkbook("فایل باید بین ۱ تا ۳۲ شیت داده داشته باشد.")
            yield workbook
    except (BadZipFile, ZipDataError, InvalidFileException, ParseError, KeyError, IndexError,
            ValueError, TypeError, OSError, OverflowError, RuntimeError) as error:
        raise InvalidWorkbook("فایل اکسل معتبر نیست یا خواندن آن امکان‌پذیر نیست.") from error


def column_key(value):
    return normalize_text(re.sub(r"[_\-\u200c]+", " ", value)).lower()


ALIASES = {column_key(alias): field for field, names in FIELDS.items() for alias in (*names, field)}


def suggest_field(title):
    key = column_key(title)
    field = ALIASES.get(key)
    if not field and ALIASES.get(re.sub(r"\s*[0-9]+$", "", key)) == "phone_numbers":
        return "phone_numbers"
    return field


def inspect_workbook(source):
    from openpyxl.utils import get_column_letter

    sheets = []
    with open_workbook(source) as workbook:
        for index, sheet in enumerate(workbook.worksheets):
            width = sheet.max_column or 0
            sheet.reset_dimensions()  # Some spreadsheet writers report an incorrect used range.
            with closing(sheet.iter_rows(values_only=True)) as rows:
                header = next(rows, ())
            width = min(MAX_COLUMNS, max(width, len(header)))
            columns = []
            used = set()
            for position in range(width):
                title = str(header[position] or "")[:150] if position < len(header) else ""
                field = suggest_field(title)
                if field in used and field != "phone_numbers":
                    field = None
                if field:
                    used.add(field)
                columns.append({"letter": get_column_letter(position + 1), "title": title, "field": field})
            sheets.append({"index": index, "name": sheet.title, "columns": columns})
    return {"sheets": sheets, "fields": [
        {"key": field, "label": aliases[0], "required": field in REQUIRED_FIELDS}
        for field, aliases in FIELDS.items()
    ]}


def template():
    from openpyxl import Workbook

    with closing(Workbook()) as workbook:
        sheet = workbook.active
        sheet.title = "مشتریان"
        sheet.sheet_view.rightToLeft = True
        sheet.freeze_panes = "A2"
        sheet.append([aliases[0] for aliases in FIELDS.values()])
        sheet.column_dimensions["C"].number_format = "@"
        buffer = BytesIO()
        workbook.save(buffer)
    return buffer.getvalue()


def cell_text(cell, *, phone=False):
    value = cell.value
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if type(value) is int or (isinstance(value, float) and value.is_integer()):
        value = int(value)
        if phone and value >= 0:
            mask = cell.number_format.split(";", 1)[0]
            if re.fullmatch(r"[0() -]+", mask):
                return str(value).zfill(min(16, mask.count("0")))
        return str(value)
    return str(value).strip()


def parse_row(row, mapping):
    values = {}
    issues = []
    for position, field in mapping:
        if position >= len(row):
            continue
        cell = row[position]
        if cell.data_type in {"f", "e"}:
            message = "مقدار ثابت وارد کنید. سلول دارای فرمول است." if cell.data_type == "f" else "سلول دارای خطای اکسل است."
            issues.append({"field": field, "message": message})
            continue
        value = cell_text(cell, phone=field == "phone_numbers")
        if not value:
            continue
        if field == "phone_numbers":
            values.setdefault(field, []).extend(part.strip() for part in re.split(r"[,،;؛\n]+", value) if part.strip())
        elif field == "gender":
            values[field] = GENDERS.get(normalize_text(value).lower(), value)
        else:
            values[field] = value
    if issues:
        return None, issues
    try:
        return CustomerWrite.model_validate(values), []
    except ValidationError as error:
        for issue in error.errors(include_url=False, include_input=False):
            field = issue["loc"][0]
            message = issue["msg"].removeprefix("Value error, ")
            if issue["type"] in {"missing", "string_too_short"}:
                message = "این فیلد الزامی است."
            elif issue["type"] == "string_too_long":
                message = f"حداکثر {issue['ctx']['max_length']} نویسه مجاز است."
            elif field == "gender":
                message = "جنسیت باید «مرد» یا «زن» باشد."
            elif field == "last_contact_date" and issue["type"] != "value_error":
                message = "تاریخ معتبر شمسی (سال/ماه/روز) یا یک سلول تاریخ اکسل وارد کنید."
            elif issue["type"] == "too_long":
                message = "حداکثر ۲۰ شماره برای هر مشتری مجاز است."
            issues.append({"field": field, "message": message})
        return None, issues


def read_rows(source, sheet_index, columns):
    if len(columns) > MAX_COLUMNS or any(field and field not in FIELDS for field in columns):
        raise InvalidWorkbook("تطبیق ستون‌ها معتبر نیست.")
    mapping = [(index, field) for index, field in enumerate(columns) if field]
    selected = [field for _, field in mapping if field != "phone_numbers"]
    if not REQUIRED_FIELDS.issubset(selected) or len(set(selected)) != len(selected):
        raise InvalidWorkbook("ستون‌های نام و نام خانوادگی را مشخص کنید. به‌جز تلفن، هر فیلد یک ستون دارد.")

    rows = []
    with open_workbook(source) as workbook:
        if not 0 <= sheet_index < len(workbook.worksheets):
            raise InvalidWorkbook("شیت انتخاب‌شده پیدا نشد.")
        sheet = workbook.worksheets[sheet_index]
        sheet.reset_dimensions()
        with closing(sheet.iter_rows()) as cells:
            for number, row in enumerate(cells, start=1):
                if number > MAX_ROWS + 1 or len(row) > MAX_COLUMNS:
                    raise InvalidWorkbook("هر شیت حداکثر ۵٬۰۰۰ ردیف داده و ۶۴ ستون می‌تواند داشته باشد.")
                if number > 1 and any(cell.value is not None and str(cell.value).strip() for cell in row):
                    data, issues = parse_row(row, mapping)
                    rows.append((number, data, issues))
    return rows


def import_rows(db, rows, *, commit):
    try:
        if commit:
            db.rollback()
            db.execute(text("BEGIN IMMEDIATE"))
        names, phones = customer_service.customer_import_conflicts(db, [data for _, data, _ in rows if data])
        seen_names, seen_phones = set(), set()
        accepted, report, preview = [], [], []
        counts = dict(duplicate=0, invalid=0)
        for number, data, issues in rows:
            status = "valid"
            if data is None:
                status = "invalid"
            else:
                name = (data.first_name.lower(), data.last_name.lower())
                duplicates = (
                    ("full_name", name in names, name in seen_names),
                    ("phone_numbers", not phones.isdisjoint(data.phone_numbers), not seen_phones.isdisjoint(data.phone_numbers)),
                )
                for field, existing, seen in duplicates:
                    if existing or seen:
                        message = "در فهرست مشتریان وجود دارد." if existing else "در ردیف قبلی فایل تکرار شده است."
                        issues.append({"field": field, "message": message})
                status = "duplicate" if issues else "valid"
                seen_names.add(name)
                seen_phones.update(data.phone_numbers)
                if status == "valid":
                    accepted.append(data)
            if issues:
                counts[status] += 1
                if commit:
                    report.append({"row": number, "status": status, "issues": issues})
            if not commit and len(preview) < PREVIEW_ROWS:
                item = {"row": number, "status": status, "issues": issues}
                if data:
                    item["values"] = data.model_dump(mode="json", exclude={"confirm_duplicate"})
                preview.append(item)
        if commit:
            customer_service.insert_customers(db, accepted)
            db.commit()
            return {"inserted": len(accepted), **counts, "report": report}
        return {"valid": len(accepted), **counts, "preview": preview}
    except Exception:
        db.rollback()
        raise
