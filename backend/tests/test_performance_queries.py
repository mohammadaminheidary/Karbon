"""Query budgets and batching parity, exclusively in a disposable database."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class PerformanceQueryTests(unittest.TestCase):
    def test_batching_preserves_values_and_bounds_queries(self):
        with tempfile.TemporaryDirectory(prefix="karbon-query-budgets-") as directory:
            result = subprocess.run([sys.executable, "-B", "-c", r'''
import app
from datetime import date
from sqlalchemy import event, text
from database import engine, SessionLocal
from models.customer import Customer
from models.order import Product, Order, OrderItem, OrderPayment
from models.finance import BankAccount, FinancialTransaction
from services import customer_service as customers, order_service as orders, finance_service as finance
from services.inventory_service import save_purchase
from services.inventory_stock import movement_summary
from services.reference_codes import compact_customer_codes, compact_transaction_numbers
from schemas.inventory_schema import PurchaseWrite
from schemas.order_schema import OrderWrite
from uuid import uuid4
count = [0]
reads = [0]
@event.listens_for(engine, "before_cursor_execute")
def counter(connection, cursor, statement, parameters, context, executemany):
    count[0] += 1
    if statement.lstrip().upper().startswith("SELECT"):
        reads[0] += 1
with SessionLocal() as db:
    db.add_all([Customer(id=i+1, customer_code=1000+i, first_name=f"مشتری {i}", last_name="آزمایش") for i in range(1, 26)])
    db.add(Product(id=1, product_code="P-000001", name="کالا", unit="عدد", price=100, stock=100))
    db.add_all([BankAccount(id=i, name=f"بانک {i}", account_number=str(i)) for i in range(1, 11)])
    db.commit()
    for i in range(1, 21):
        orders.save_order(db, OrderWrite(request_id=uuid4(), customer_id=i+1, invoice_date="1405/07/01", payment_date="1405/07/01",
            items=[dict(product_id=1, quantity=1, unit_price=100)], payments=[dict(method="pos", bank_id=1, amount=30), dict(method="transfer", bank_id=1, amount=40)]))
    count[0] = 0
    page = customers.list_customers(db, limit=25)
    assert count[0] <= 3, count
    for row in page["items"]:
        assert row["summary"] == customers.get_summary(db, row["id"])
    count[0] = 0
    options = customers.list_customers(db, search="مشتری 2", limit=3, options_only=True)
    assert count[0] == 2 and len(options["items"]) == 3
    assert set(options["items"][0]) == {"id", "customer_code", "first_name", "last_name", "phone_numbers", "is_system"}
    selected = customers.list_customers(db, options_only=True, customer_id=1)
    assert selected["total"] == 1 and selected["items"][0]["id"] == 1
    count[0] = 0
    page = orders.list_orders(db, "active", 0, 20)
    assert count[0] <= 7, count
    for row in page["items"]:
        assert row == orders.serialize(db, db.get(Order, row["id"]))
    count[0] = 0
    invoices = orders.list_invoices(db, "", 0, 20)
    assert count[0] <= 5, count
    for row in invoices["items"]:
        expected = orders.serialize(db, db.get(Order, row["id"]))
        assert {k: v for k, v in row.items() if k != "customer"} == expected
    assert orders.list_invoices(db, "مشتری 2", 0, 3)["total"] == 2
    count[0] = 0
    daily = finance.daily(db, date(2026, 9, 23))
    assert count[0] <= 3, count
    assert len(daily["transactions"]) == 40
    assert all(row["invoice"]["paid"] == 70 and row["invoice"]["remaining"] == 30 for row in daily["transactions"])
    count[0] = 0
    banks = finance.bank_list(db)
    assert count[0] == 2 and not banks[0]["can_delete"] and banks[1]["can_delete"]
    count[0] = 0
    assert finance.bank_list(db, 1) == [banks[0]] and count[0] == 2
    db.rollback(); db.execute(text("BEGIN IMMEDIATE"))
    count[0] = 0
    compact_transaction_numbers(db)
    assert count[0] == 1, count  # no updates for already contiguous numbers
    db.query(Customer).filter(Customer.id == 26).delete(); db.flush()
    compact_customer_codes(db)
    assert db.query(Customer.customer_code).order_by(Customer.id).all() == [(1000+i,) for i in range(25)]
    db.rollback()

    category_id = db.scalar(text("SELECT id FROM inventory_options WHERE kind='categories' LIMIT 1"))
    stock_products = [Product(id=i, product_code=f"P-{i:06d}", name=f"کالا {i}",
                              unit="عدد", category_id=category_id, price=100, stock=100)
                      for i in range(2, 42)]
    db.add_all(stock_products)
    db.commit()
    day = "1405/07/02"
    for size in (1, 40):
        rows = [dict(product_id=i, quantity=1, category_id=category_id, purchase_price=100)
                for i in range(2, 2 + size)]
        reads[0] = 0
        receipt = save_purchase(db, PurchaseWrite(request_id=uuid4(), purchase_date=day, rows=rows))
        assert receipt["row_count"] == size and receipt["total"] == size * 100
        if size == 1:
            purchase_reads = reads[0]
        else:
            assert reads[0] == purchase_reads, (purchase_reads, reads[0])
        rows = [dict(product_id=i, quantity=1, unit_price=100) for i in range(2, 2 + size)]
        reads[0] = 0
        order = orders.save_order(db, OrderWrite(request_id=uuid4(), customer_id=1,
            invoice_date=day, payment_date=day, items=rows))
        assert len(order["items"]) == size and order["total"] == size * 100
        if size == 1:
            sale_reads = reads[0]
        else:
            assert reads[0] == sale_reads, (sale_reads, reads[0])
    reads[0] = 0
    assert movement_summary(db, date(2026, 9, 24)) == {"incoming": 40, "outgoing": 0}
    assert reads[0] == 1, reads
'''], cwd=ROOT / "backend", env=dict(os.environ, KARBON_DATABASE_PATH=str(Path(directory)/"test.db"), KARBON_JWT_SECRET="query-budget-test-only", PYTHONDONTWRITEBYTECODE="1"), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
