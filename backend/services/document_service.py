import hashlib
import json
import re
from datetime import datetime, timezone
from uuid import uuid5

import jdatetime
from sqlalchemy import func, or_, text
from sqlalchemy.schema import CreateTable
from sqlalchemy.exc import IntegrityError

from config import APP_TIMEZONE
from models.document import Document, DocumentAccount
from models.finance import BankAccount, BankDirectory, FinancialTransaction as Transaction
from models.order import OrderPayment
from schemas.customer_schema import normalize_text
from schemas.finance_schema import TransactionEdit
from security.password import verify_password
from services.finance_service import FinanceError, apply_transaction_fields, require, serialize, sums
from services.reference_codes import compact_transaction_numbers


def initialize_document_storage(engine):
    """Upgrade earlier document-only installations without inventing ledger entries."""
    # SQLite needs a table rebuild to widen the source CHECK constraint. Disable
    # FK enforcement only on this connection, outside the serialized transaction;
    # copy IDs verbatim and check every FK before committing, then restore it.
    with engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.commit()
        try:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            for table, additions in {
                "documents": {"request_id": "VARCHAR(36)", "last_request_id": "VARCHAR(36)", "request_fingerprint": "VARCHAR(64)", "revision": "INTEGER NOT NULL DEFAULT 1", "deleted_at": "DATETIME"},
                "financial_transactions": {"document_id": "INTEGER REFERENCES documents(id) ON DELETE RESTRICT"},
            }.items():
                columns = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({table})")}
                for column, sql_type in additions.items():
                    if column not in columns:
                        connection.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}")
            ddl = connection.exec_driver_sql("SELECT sql FROM sqlite_master WHERE type='table' AND name='financial_transactions'").scalar()
            if "document_account_id IS NULL" not in ddl:
                columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(financial_transactions)")}
                definition = str(CreateTable(Transaction.__table__).compile(connection)).replace("CREATE TABLE financial_transactions", "CREATE TABLE financial_transactions_upgrade", 1)
                connection.exec_driver_sql(definition)
                fields = ", ".join(column.name for column in Transaction.__table__.columns if column.name in columns)
                connection.exec_driver_sql(f"INSERT INTO financial_transactions_upgrade ({fields}) SELECT {fields} FROM financial_transactions")
                connection.exec_driver_sql("DROP TABLE financial_transactions")
                connection.exec_driver_sql("ALTER TABLE financial_transactions_upgrade RENAME TO financial_transactions")
            for index in Transaction.__table__.indexes:
                index.create(bind=connection, checkfirst=True)
            # Copy only accounts already used by documents. No customer/category
            # relationships remain on these rows, so future renumbering is isolated.
            legacy = connection.execute(text("SELECT id, document_id, kind, title, account_code FROM financial_transactions WHERE document_id IS NOT NULL AND document_account_id IS NULL")).mappings().all()
            accounts = {(row.code, row.kind): row.id for row in connection.execute(text("SELECT id, code, kind FROM document_accounts"))}
            used_codes = {code for code, _ in accounts}
            changed = set()
            for row in legacy:
                key = (row["account_code"], row["kind"])
                account_id = accounts.get(key)
                if account_id is None:
                    code = row["account_code"]
                    if code in used_codes:
                        code = f"{code[:30]}-D-{row['id']}"
                    account_id = connection.execute(DocumentAccount.__table__.insert().values(code=code, title=row["title"], kind=row["kind"], active=True)).inserted_primary_key[0]
                    accounts[key] = account_id
                    used_codes.add(code)
                connection.execute(text("UPDATE financial_transactions SET document_account_id=:account, customer_id=NULL, expense_category_id=NULL, account_code=(SELECT code FROM document_accounts WHERE id=:account) WHERE id=:id"), {"account":account_id, "id":row["id"]})
                changed.add(row["document_id"])
            for document_id in changed:
                connection.execute(text("UPDATE documents SET revision=revision+1, request_fingerprint=NULL WHERE id=:id"), {"id":document_id})
            connection.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ux_document_request ON documents(request_id)")
            connection.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ux_document_last_request ON documents(last_request_id)")
            connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_documents_date_id ON documents(date, id)")
            if connection.exec_driver_sql("PRAGMA foreign_key_check").fetchone():
                raise RuntimeError("Document account migration would break ledger references")
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
            connection.commit()


def account_list(db):
    return [{"id": item.id, "code": item.code, "title": item.title, "kind": item.kind, "active": item.active,
             "can_delete": not db.query(Transaction.id).filter(Transaction.document_account_id == item.id, Transaction.deleted_at.is_(None)).first()}
            for item in db.query(DocumentAccount).filter(DocumentAccount.deleted_at.is_(None)).order_by(DocumentAccount.code).all()]


def save_account(db, data, account_id=None):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        account = require(db, DocumentAccount, account_id, "حساب سند") if account_id is not None else DocumentAccount()
        if account_id is None:
            # Allocate under the same write lock as insertion. Retired codes
            # stay reserved so historical document references never change.
            codes = db.query(DocumentAccount.code).filter(DocumentAccount.code.like("D-%")).all()
            sequence = max((int(match.group(1)) for (code,) in codes if (match := re.fullmatch(r"D-([0-9]{6,})", code))), default=0) + 1
            account.code = f"D-{sequence:06d}"
        if account_id is not None and account.kind != data.kind and db.query(Transaction.id).filter(Transaction.document_account_id == account.id).first():
            raise FinanceError("نوع حساب استفاده‌شده در سند قابل تغییر نیست؛ حساب جدید تعریف کنید.", 409)
        for key, value in data.model_dump().items():
            setattr(account, key, value)
        db.add(account)
        db.flush()
        db.query(Transaction).filter(Transaction.document_account_id == account.id).update({Transaction.account_code: account.code, Transaction.title: account.title}, synchronize_session=False)
        # Existing open editors must reload if their account definition changes.
        if account_id is not None:
            affected = db.query(Transaction.document_id).filter(Transaction.document_account_id == account.id).distinct()
            db.query(Document).filter(Document.id.in_(affected)).update({Document.revision: Document.revision + 1}, synchronize_session=False)
        result = next(item for item in account_list(db) if item["id"] == account.id)
        db.commit()
        return result
    except IntegrityError:
        db.rollback()
        raise FinanceError("این کد حساب قبلاً ثبت شده است.", 409)
    except Exception:
        db.rollback()
        raise


def delete_account(db, account_id, data, user):
    if not verify_password(data.password, user.password_hash):
        raise FinanceError("رمز حساب کاربری صحیح نیست.", 403)
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        account = require(db, DocumentAccount, account_id, "حساب سند", include_deleted=True)
        if account.deleted_at is None:
            if db.query(Transaction.id).filter(Transaction.document_account_id == account.id, Transaction.deleted_at.is_(None)).first():
                raise FinanceError("این حساب در سند ثبت‌شده استفاده شده است؛ آن را غیرفعال کنید یا ابتدا سند را ویرایش کنید.", 409)
            account.deleted_at = datetime.now(timezone.utc)
            account.active = False
        db.commit()
        return {"id":account_id, "deleted":True}
    except Exception:
        db.rollback()
        raise


def summary(document, income=0, expense=0, count=0):
    return {**{field: getattr(document, field) for field in ("id", "number", "description", "date", "document_type", "created_at", "revision")},
            "total_income": int(income), "total_expense": int(expense), "row_count": count}


def list_documents(db, search="", start_date=None, end_date=None, document_type="", skip=0, limit=15):
    query = db.query(Document).filter(Document.deleted_at.is_(None))
    total = query.count()
    search = normalize_text(search)
    if search:
        row_matches = db.query(Transaction.document_id).filter(Transaction.deleted_at.is_(None), Transaction.description.contains(search, autoescape=True))
        query = query.filter(or_(Document.number.contains(search, autoescape=True), Document.description.contains(search, autoescape=True), Document.id.in_(row_matches)))
    if start_date:
        query = query.filter(Document.date >= start_date)
    if end_date:
        query = query.filter(Document.date <= end_date)
    if document_type:
        query = query.filter(Document.document_type == normalize_text(document_type))
    filtered_total = query.count()
    documents = query.order_by(Document.date.desc(), Document.id.desc()).offset(skip).limit(limit).all()
    aggregates = {key: (income, expense, count) for key, income, expense, count in db.query(
        Transaction.document_id, *sums(), func.count(Transaction.id)).filter(
        Transaction.document_id.in_([item.id for item in documents]), Transaction.deleted_at.is_(None)).group_by(Transaction.document_id).all()}
    return {
        "total": total, "filtered_total": filtered_total,
        "items": [summary(item, *aggregates.get(item.id, (0, 0, 0))) for item in documents],
        "document_types": [row[0] for row in db.query(Document.document_type).filter(Document.deleted_at.is_(None)).distinct().order_by(Document.document_type).all()],
        "available_dates": [row[0] for row in db.query(Document.date).filter(Document.deleted_at.is_(None)).distinct().order_by(Document.date).all()],
    }


def get_document(db, document_id):
    document = require(db, Document, document_id, "سند")
    rows = db.query(Transaction, BankAccount, BankDirectory).join(BankAccount, Transaction.bank_id == BankAccount.id).outerjoin(
        BankDirectory, BankAccount.bank == BankDirectory.code).filter(Transaction.document_id == document.id, Transaction.deleted_at.is_(None)).order_by(Transaction.id).all()
    income = sum(item.amount for item, _, _ in rows if item.kind == "income")
    expense = sum(item.amount for item, _, _ in rows if item.kind == "expense")
    return {**summary(document, income, expense, len(rows)), "rows": [serialize(item, bank, directory) for item, bank, directory in rows]}


def fingerprint(data):
    return hashlib.sha256(json.dumps(data.model_dump(mode="json", exclude={"request_id"}), ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def next_number(db, now):
    # The write lock makes the sequence preview authoritative at POST time.
    sequence = (db.query(func.max(Document.id)).scalar() or 0) + 1
    return f"{jdatetime.date.fromgregorian(date=now.date()).strftime('%Y%m%d')}-{now.strftime('%H%M%S')}-{sequence:06d}"


def preview_number(db):
    return {"number": next_number(db, datetime.now(APP_TIMEZONE))}


def save_document(db, data, document_id=None):
    digest = fingerprint(data)
    request_id = str(data.request_id)
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        if document_id is None:
            document = db.query(Document).filter(Document.request_id == request_id).first()
        else:
            document = require(db, Document, document_id, "سند")
        if document is not None and document.deleted_at is not None:
            raise FinanceError("این سند حذف شده است؛ درخواست قبلی قابل تکرار نیست.", 410)
        if document is not None and document.last_request_id == request_id:
            if document.request_fingerprint != digest:
                raise FinanceError("شناسه درخواست قبلاً برای اطلاعات دیگری استفاده شده است.", 409)
            result = get_document(db, document.id)
            db.commit()
            return result
        if document_id is None and document is not None:
            raise FinanceError("این سند قبلاً ثبت و سپس ویرایش شده است؛ اطلاعات آن را دوباره دریافت کنید.", 409)
        if document_id is not None and data.revision != document.revision:
            raise FinanceError("سند در جای دیگری تغییر کرده است؛ جزئیات را دوباره دریافت و ویرایش کنید.", 409)
        now = datetime.now(APP_TIMEZONE)
        if document is None:
            if any(row.id is not None for row in data.rows):
                raise FinanceError("سند جدید نباید شناسه ردیف قبلی داشته باشد.", 422)
            document = Document(number=next_number(db, now), request_id=request_id, revision=1)
            db.add(document)
        else:
            document.revision += 1
        document.date = data.date
        document.description = data.description
        kinds = {row.kind for row in data.rows}
        document.document_type = "سند ترکیبی" if len(kinds) > 1 else "درآمد" if "income" in kinds else "هزینه"
        document.last_request_id = request_id
        document.request_fingerprint = digest
        db.flush()
        existing = {item.id: item for item in db.query(Transaction).filter(Transaction.document_id == document.id, Transaction.deleted_at.is_(None)).all()}
        used = set()
        count = db.query(Transaction.id).filter(Transaction.deleted_at.is_(None)).count()
        for index, row in enumerate(data.rows):
            if row.id is not None and row.id not in existing:
                raise FinanceError("ردیف انتخاب‌شده به این سند تعلق ندارد یا حذف شده است.", 409)
            item = existing[row.id] if row.id is not None else Transaction(request_id=str(uuid5(data.request_id, f"row-{index}")), document_id=document.id, transaction_number=count + index + 1)
            if row.id is not None:
                used.add(row.id)
            if item.id and db.query(OrderPayment.id).filter(OrderPayment.transaction_id == item.id).first():
                raise FinanceError("پرداخت متصل به فاکتور نهایی‌شده از سند قابل تغییر نیست.", 409)
            fields = TransactionEdit(**row.model_dump(exclude={"id"}), transaction_date=jdatetime.date.fromgregorian(date=data.date).strftime("%Y/%m/%d"), time_mode="auto")
            apply_transaction_fields(db, item, fields, now)
            db.add(item)
        for key, item in existing.items():
            if key not in used:
                if db.query(OrderPayment.id).filter(OrderPayment.transaction_id == key).first():
                    raise FinanceError("پرداخت متصل به فاکتور نهایی‌شده قابل حذف نیست.", 409)
                item.deleted_at = item.updated_at = datetime.now(timezone.utc)
        db.flush()
        compact_transaction_numbers(db)
        db.expire_all()
        result = get_document(db, document.id)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def delete_document(db, document_id, data, user):
    if not verify_password(data.password, user.password_hash):
        raise FinanceError("رمز حساب کاربری صحیح نیست.", 403)
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        document = require(db, Document, document_id, "سند", include_deleted=True)
        if document.deleted_at is None:
            rows = db.query(Transaction).filter(Transaction.document_id == document.id).all()
            if db.query(OrderPayment.id).join(Transaction, OrderPayment.transaction_id == Transaction.id).filter(Transaction.document_id == document.id).first():
                raise FinanceError("سند دارای پرداخت فاکتور نهایی‌شده قابل حذف نیست.", 409)
            document.deleted_at = datetime.now(timezone.utc)
            for item in rows:
                item.deleted_at = item.updated_at = document.deleted_at
            db.flush()
            compact_transaction_numbers(db)
            db.expire_all()
        db.commit()
        return {"id": document_id, "deleted": True}
    except Exception:
        db.rollback()
        raise
