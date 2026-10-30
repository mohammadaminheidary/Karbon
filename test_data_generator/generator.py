"""Transactional synthetic data using Karbon's schema; never imports app startup."""
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta, time, timezone
import hashlib
import json
from pathlib import Path
import random
import sys
from uuid import uuid4

import jdatetime
from sqlalchemy import (Column, Integer, MetaData, String, Table, delete, func,
                        inspect, select, text)
from sqlalchemy.orm import Session

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))
# Match start.py's backend-relative database overrides without changing cwd.
import os
if os.environ.get("KARBON_DATABASE_PATH"):
    os.environ["KARBON_DATABASE_PATH"] = str(
        (BACKEND / Path(os.environ["KARBON_DATABASE_PATH"]).expanduser()).resolve())

from config import APP_TIMEZONE, DATABASE_PATH
from database import engine
import models
from models import Customer, BankAccount, ExpenseCategory, FinancialTransaction, Document, DocumentAccount, Task, Member, Attendance
from models.order import Order, OrderItem, OrderPayment, Product
from models.inventory import InventoryOption
from schemas.customer_schema import CustomerWrite
from schemas.order_schema import ProductWrite, OrderWrite
from schemas.finance_schema import CategoryWrite, TransactionLine
from schemas.document_schema import DocumentCreate
from services.order_service import serialize, load_order_relations
from services.document_service import fingerprint as document_fingerprint

metadata = MetaData()
# Explicit ownership is independent of names, notes, display codes and soft deletes.
owned = Table("karbon_test_data_records", metadata,
    Column("table_name", String(80), primary_key=True),
    Column("record_id", Integer, primary_key=True),
    Column("batch_id", String(36), nullable=False, index=True),
    Column("digest", String(64), nullable=False))
MODELS = [Customer, BankAccount, ExpenseCategory, DocumentAccount, Product,
          InventoryOption, Member, Attendance, Task, Document, Order,
          OrderItem, FinancialTransaction, OrderPayment]
TABLES = {model.__tablename__: model.__table__ for model in MODELS}
CHUNK = 250


class SafetyError(RuntimeError):
    pass


def digest(row):
    return hashlib.sha256(json.dumps(dict(row), sort_keys=True, default=str,
                                    ensure_ascii=False).encode()).hexdigest()


def chunks(values):
    for offset in range(0, len(values), CHUNK):
        yield values[offset:offset + CHUNK]


class Generator:
    def __init__(self, database_engine=engine, *, connection=None):
        self.engine = database_engine
        # Used by rollback-only verification against the existing database.
        self.connection = connection

    @contextmanager
    def atomic(self):
        if self.connection is not None:
            with self.connection.begin_nested():
                self.prepare(self.connection)
                yield self.connection
            return
        if self.engine.url.database != ":memory:" and not Path(self.engine.url.database).is_file():
            raise SafetyError("Existing database not found. Start Karbon once to initialize it.")
        with self.engine.connect() as connection:
            try:
                connection.exec_driver_sql("BEGIN IMMEDIATE")
                self.prepare(connection)
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def prepare(self, connection):
        if connection.exec_driver_sql("PRAGMA foreign_keys").scalar() != 1:
            raise SafetyError("SQLite foreign keys must be enabled.")
        inspector = inspect(connection)
        for name, table in TABLES.items():
            if not inspector.has_table(name):
                raise SafetyError(f"Missing {name}. Start Karbon to initialize its schema first.")
            columns = {column["name"] for column in inspector.get_columns(name)}
            if not set(table.c.keys()) <= columns:
                raise SafetyError(f"Outdated {name} schema. Run Karbon's existing migrations first.")
        metadata.create_all(connection)

    def generate(self, count=1000, progress=lambda value, message: None):
        if type(count) is not int or not 1 <= count <= 100000:
            raise ValueError("Customer count must be an integer between 1 and 100,000.")
        batch = str(uuid4())
        label = f"TEST {batch}"
        rng = random.Random(batch)
        today = datetime.now(APP_TIMEZONE).date()
        rows = defaultdict(list)
        with self.atomic() as connection:
            next_ids = {name: (connection.scalar(select(func.max(table.c.id))) or 0)
                        for name, table in TABLES.items()}
            # Respect AUTOINCREMENT high-water marks even after hard deletes.
            if inspect(connection).has_table("sqlite_sequence"):
                for name, sequence in connection.exec_driver_sql("SELECT name, seq FROM sqlite_sequence"):
                    if name in next_ids:
                        next_ids[name] = max(next_ids[name], sequence)
            def add(model, **values):
                name = model.__tablename__
                next_ids[name] += 1
                row = dict(id=next_ids[name], **values)
                rows[name].append(row)
                return row
            code = max(1000, connection.scalar(select(func.max(Customer.customer_code))) or 0)
            transaction_number = connection.scalar(select(func.max(FinancialTransaction.transaction_number))) or 0
            category_code = (connection.scalar(select(func.max(ExpenseCategory.display_code))) or 0) + 1
            bank = add(BankAccount, name=f"Synthetic account {batch}", account_number=f"TEST-{batch}",
                       first_name="آزمایشی", last_name="کاربن", opening_balance=count * 1000000)
            category = add(ExpenseCategory, title=CategoryWrite(title=f"مواد اولیه {label}").title, display_code=category_code)
            doc_account = add(DocumentAccount, code=f"T-{batch}", title=f"خرید مواد اولیه {label}", kind="expense")
            for kind, name in [("categories", "مواد اولیه"), ("units", "عدد")]:
                add(InventoryOption, kind=kind, name=f"{name} {label}")
            catalog = []
            for index in range(min(30, count)):
                fields = ProductWrite(name=f"{['چاپ کارت', 'بسته بندی', 'کاتالوگ', 'بنر'][index % 4]} {label} {index + 1}",
                                      unit="عدد", price=rng.randrange(10, 100) * 1000, stock=count * 10)
                catalog.append(add(Product, product_code=f"T-{batch[:16]}-{index + 1}", **fields.model_dump()))
            members = [add(Member, first_name="علی", last_name=f"اپراتور آزمایشی {batch[:8]} {index}")
                       for index in range(min(10, count))]
            for index in range(count):
                day = today - timedelta(days=index % 28)
                created = datetime.combine(day, time(9), APP_TIMEZONE).astimezone(timezone.utc)
                fields = CustomerWrite(first_name=rng.choice(["سارا", "مریم", "نگار"] if index % 2 else ["علی", "رضا", "نیما"]),
                    last_name=rng.choice(["احمدی", "کریمی", "رضایی", "محمدی"]),
                    gender="female" if index % 2 else "male", address=f"تهران، خیابان آزادی، پلاک {index + 1}",
                    phone_numbers=[f"0912{rng.randrange(1000000, 10000000)}"], last_contact_date=day, notes=label)
                customer = add(Customer, customer_code=code + index + 1,
                    **fields.model_dump(exclude={"confirm_duplicate"}), created_at=created, updated_at=created)
                product = catalog[index % len(catalog)]
                quantity = rng.randint(1, 4)
                product["stock"] -= quantity
                subtotal = quantity * product["price"]
                discount = subtotal // 20 if index % 4 == 0 else 0
                paid = (subtotal - discount) * (index % 3) // 2
                request_id = uuid4()
                # Reuse the API's date, item, discount and payment validation.
                jalali = jdatetime.date.fromgregorian(date=day).strftime("%Y/%m/%d")
                payload = OrderWrite(request_id=request_id, customer_id=customer["id"],
                    order_number=f"T-{batch}-{index + 1}", invoice_date=jalali, payment_date=jalali,
                    items=[dict(product_id=product["id"], quantity=quantity, unit_price=product["price"])],
                    payments=[dict(method="transfer", amount=paid, bank_id=bank["id"])] if paid else [],
                    description=label, discount=discount)
                order = add(Order, request_id=str(request_id), request_fingerprint=hashlib.sha256(
                    payload.model_dump_json(exclude={"request_id"}).encode()).hexdigest(),
                    invoice_code=f"T-{uuid4().hex}", order_number=payload.order_number,
                    customer_id=customer["id"], invoice_date=day, payment_date=day, description=label,
                    subtotal=subtotal, discount=discount, status="completed" if index % 2 else "active", created_at=created)
                add(OrderItem, order_id=order["id"], product_id=product["id"], position=1,
                    product_name=product["name"], unit=product["unit"], quantity=quantity, unit_price=product["price"])

                def transaction(amount, kind, **source):
                    nonlocal transaction_number
                    TransactionLine(kind=kind, amount=amount, bank_id=bank["id"],
                                    **{k: v for k, v in source.items() if k.endswith("_id") and k != "document_id"})
                    transaction_number += 1
                    return add(FinancialTransaction, request_id=str(uuid4()), kind=kind, bank_id=bank["id"],
                        amount=amount, title=label, account_code=str(customer["customer_code"]) if kind == "income" else f"E-{category_code:06d}",
                        transaction_number=transaction_number, description=label, transaction_date=day,
                        transaction_time="10:30:00", time_mode="manual", created_at=created, updated_at=created, **source)
                if paid:
                    receipt = transaction(paid, "income", customer_id=customer["id"])
                    add(OrderPayment, order_id=order["id"], transaction_id=receipt["id"], method="transfer")
                transaction(rng.randrange(5, 30) * 1000, "expense", expense_category_id=category["id"])
                purchase_cost = quantity * product["price"] // 2
                doc_payload = DocumentCreate(request_id=uuid4(), date=day, description=f"خرید مواد اولیه {label}",
                    rows=[dict(kind="expense", amount=purchase_cost, bank_id=bank["id"], document_account_id=doc_account["id"])])
                document = add(Document, number=f"T-{batch}-{index + 1}",
                    date=day, document_type="هزینه", description=doc_payload.description, created_at=created,
                    request_id=str(doc_payload.request_id), last_request_id=str(doc_payload.request_id),
                    request_fingerprint=document_fingerprint(doc_payload))
                purchase = transaction(purchase_cost, "expense", document_id=document["id"], document_account_id=doc_account["id"])
                purchase["account_code"] = doc_account["code"]
                add(Task, date=day, title=f"تولید سفارش {order['order_number']}",
                    description=f"{label} · {quantity} {product['unit']} {product['name']}",
                    status="completed" if order["status"] == "completed" else "in_progress", created_at=created)
                if index < len(members):
                    add(Attendance, member_id=members[index]["id"], date=today, status="present", recorded_time=time(9))
                if index % CHUNK == 0:
                    progress(5 + 30 * index / count, f"Preparing customer {index + 1:,} / {count:,}")
            for position, model in enumerate(MODELS):
                name = model.__tablename__
                # Uniform keys preserve nullable financial source columns in executemany.
                values = rows[name]
                keys = set().union(*(row.keys() for row in values)) if values else set()
                values = [{key: row.get(key) for key in keys} for row in values]
                for part in chunks(values):
                    connection.execute(TABLES[name].insert(), part)
                progress(35 + 35 * (position + 1) / len(MODELS), f"Inserted {len(values):,} {name}")
            # Use Karbon's own invoice serializer with batch-loaded relationships.
            with Session(bind=connection, join_transaction_mode="create_savepoint") as db:
                for part in chunks([row["id"] for row in rows["orders"]]):
                    orders = db.query(Order).filter(Order.id.in_(part)).all()
                    loaded = load_order_relations(db, orders)
                    for order in orders:
                        customer, items, payments = loaded[order.id]
                        snapshot = serialize(db, order, loaded=loaded[order.id])
                        snapshot.update(customer=dict(code=customer.customer_code,
                            name=f"{customer.first_name} {customer.last_name}", phone_numbers=customer.phone_numbers,
                            address=customer.address), store=None, version=1)
                        for item in snapshot["items"]:
                            item["product_code"] = next(p["product_code"] for p in catalog if p["id"] == item["product_id"])
                        for payment in snapshot["payments"]:
                            payment["account_name"] = bank["name"]
                        order.invoice_snapshot = json.loads(json.dumps(snapshot, default=str, ensure_ascii=False))
                    db.flush()
                    db.expunge_all()
                db.commit()
            for position, (name, values) in enumerate(rows.items()):
                for part in chunks([row["id"] for row in values]):
                    saved = connection.execute(select(TABLES[name]).where(TABLES[name].c.id.in_(part))).mappings()
                    connection.execute(owned.insert(), [dict(table_name=name, record_id=row["id"], batch_id=batch, digest=digest(row)) for row in saved])
                progress(70 + 29 * (position + 1) / len(rows), f"Tracking {name}")
            progress(99, "Committing batch…")
        progress(100, "Generation complete")
        return dict(batch_id=batch, counts={name: len(values) for name, values in rows.items()}, total=sum(map(len, rows.values())))

    def delete(self, progress=lambda value, message: None):
        """Clear all business data, including real, edited and untracked records.

        Keep authentication and the bundled bank catalog so Karbon remains usable.
        The user explicitly requested a complete dashboard reset via this button.
        """
        counts = {}
        with self.atomic() as connection:
            actual = MetaData()
            actual.reflect(connection)
            tables = [table for table in reversed(actual.sorted_tables)
                      if table.name not in {"users", "bank_directory", "customer_id_registry"}]
            for index, table in enumerate(tables):
                deleted = connection.execute(delete(table)).rowcount
                if table.name != owned.name:
                    counts[table.name] = deleted
                progress(95 * (index + 1) / max(1, len(tables)),
                         f"Cleared {table.name}: {deleted:,} records")
            progress(99, "Committing full data reset…")
        progress(100, "All business data deleted · dashboard is empty")
        return dict(counts=counts, total=sum(counts.values()))

    def delete_generated(self, progress=lambda value, message: None):
        """Optional programmatic cleanup limited to untouched generated records."""
        counts = Counter()
        with self.atomic() as connection:
            tracked = defaultdict(dict)
            for row in connection.execute(select(owned)).mappings():
                if row["table_name"] not in TABLES:
                    raise SafetyError("Unknown ownership table; deletion cancelled.")
                tracked[row["table_name"]][row["record_id"]] = row["digest"]
            for name, records in tracked.items():
                for part in chunks(list(records)):
                    for row in connection.execute(select(TABLES[name]).where(TABLES[name].c.id.in_(part))).mappings():
                        if digest(row) != records[row["id"]]:
                            raise SafetyError(f"{name} #{row['id']} changed since generation. Nothing deleted; resolve the change before retrying.")
            # Inspect every actual FK, including cascading tables outside the generator.
            # An unowned child must never be cascaded away or left pointing at test data.
            actual = MetaData()
            actual.reflect(connection)
            for table in actual.tables.values():
                for fk in table.foreign_keys:
                    parent = fk.column.table.name
                    ids = tracked.get(parent, {})
                    if not ids:
                        continue
                    for part in chunks(list(ids)):
                        query = select(table).where(fk.parent.in_(part))
                        for row in connection.execute(query).mappings():
                            if row.get("id") not in tracked.get(table.name, {}):
                                raise SafetyError(f"Real {table.name} data references generated {parent}. Nothing deleted.")
            tables = [table for table in reversed(actual.sorted_tables) if table.name in tracked]
            for index, table in enumerate(tables):
                for part in chunks(list(tracked[table.name])):
                    counts[table.name] += connection.execute(delete(table).where(table.c.id.in_(part))).rowcount
                progress(10 + 85 * (index + 1) / max(1, len(tables)), f"Deleted {counts[table.name]:,} {table.name}")
            connection.execute(delete(owned))
            progress(99, "Committing deletion…")
        progress(100, "Deletion complete")
        return dict(counts=dict(counts), total=sum(counts.values()))
