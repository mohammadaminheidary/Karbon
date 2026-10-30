"""Rollback-only verification on Karbon's existing database, never a copy."""
from datetime import datetime, timedelta
import unittest

from sqlalchemy import MetaData, select, text
from sqlalchemy.orm import Session

from test_data_generator.generator import (Generator, SafetyError, TABLES, owned,
    engine, DATABASE_PATH, APP_TIMEZONE, Customer, Order, Product, Task, Member,
    Attendance, FinancialTransaction, OrderItem, OrderPayment)
from services.dashboard_service import dashboard
from services.order_service import list_invoices, invoice, order_details
from services.document_service import list_documents, get_document


class GeneratorIntegrationTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        engine.dispose()

    def setUp(self):
        self.assertTrue(DATABASE_PATH.is_file(), "Start Karbon first; tests never create a database")
        self.connection = engine.connect()
        self.addCleanup(self.connection.close)
        self.addCleanup(self.connection.rollback)
        self.connection.exec_driver_sql("BEGIN IMMEDIATE")
        self.generator = Generator(connection=self.connection)
        self.generator.prepare(self.connection)
        # Treat pre-existing batches as real/unowned baseline data for this run.
        # Their ownership entries are restored by the outer transaction rollback.
        self.connection.execute(owned.delete())
        self.baseline = self.snapshot()

    def snapshot(self):
        metadata = MetaData()
        metadata.reflect(self.connection)
        return {table.name: sorted((repr(tuple(row)) for row in self.connection.execute(select(table))))
                for table in metadata.tables.values()}

    def report(self):
        # dashboard starts its own read transaction: use a savepoint-bound session.
        with Session(bind=self.connection, join_transaction_mode="create_savepoint") as db:
            # It explicitly issues BEGIN; isolate just that redundant BEGIN within
            # the already-open verification transaction, keeping all query code intact.
            original = db.execute
            def execute(statement, *args, **kwargs):
                if str(statement) == "BEGIN":
                    return None
                return original(statement, *args, **kwargs)
            db.execute = execute
            today = datetime.now(APP_TIMEZONE).date()
            return dashboard(db, today - timedelta(days=29), today)

    def test_thousand_customers_two_cycles_and_dashboard(self):
        before = self.report()
        for cycle in range(2):
            result = self.generator.generate(1000)
            self.assertEqual(result["counts"]["customers"], 1000)
            self.assertEqual(result["counts"]["orders"], 1000)
            self.assertGreater(result["total"], 8000)
            self.assertEqual(self.connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])
            after = self.report()
            self.assertEqual(after["customers"]["total"] - before["customers"]["total"], 1000)
            self.assertEqual(after["orders"]["count"] - before["orders"]["count"], 1000)
            self.assertEqual(after["documents"]["total"] - before["documents"]["total"], 1000)
            self.assertEqual(after["tasks"]["total"] - before["tasks"]["total"], 1000)
            self.assertGreater(int(after["finance"]["income"]), int(before["finance"]["income"]))
            self.assertGreater(int(after["finance"]["expense"]), int(before["finance"]["expense"]))
            with Session(bind=self.connection, join_transaction_mode="create_savepoint") as db:
                invoices = list_invoices(db, "T-", 0, 5)
                self.assertGreaterEqual(invoices["total"], 1000)
                for row in invoices["items"]:
                    saved = invoice(db, row["id"])
                    self.assertEqual(saved["total"], sum(item["total"] for item in saved["items"]) - saved["discount"])
                    self.assertEqual(saved["remaining"], saved["total"] - saved["paid"])
                    self.assertTrue(saved["items"][0]["product_code"])
                    self.assertEqual(order_details(db, row["id"])["paid"], saved["paid"])
                documents = list_documents(db, search="TEST", limit=5)
                self.assertGreaterEqual(documents["filtered_total"], 1000)
                for row in documents["items"]:
                    document = get_document(db, row["id"])
                    self.assertEqual(document["total_expense"], sum(item["amount"] for item in document["rows"]))
            # All generated orders, not only the first page, reconcile.
            invalid = self.connection.execute(text('''
                SELECT o.id FROM orders o JOIN karbon_test_data_records r
                ON r.table_name='orders' AND r.record_id=o.id
                WHERE o.subtotal != (SELECT SUM(quantity*unit_price) FROM order_items i WHERE i.order_id=o.id)
                OR o.subtotal-o.discount < COALESCE((SELECT SUM(t.amount) FROM order_payments p
                    JOIN financial_transactions t ON t.id=p.transaction_id WHERE p.order_id=o.id),0)
            ''')).all()
            self.assertEqual(invalid, [])
            # Stock reflects sold quantity and remains nonnegative.
            for product in self.connection.execute(select(Product.__table__).where(
                    Product.id.in_(select(owned.c.record_id).where(owned.c.table_name == "products")))).mappings():
                sold = self.connection.execute(text("SELECT SUM(quantity) FROM order_items WHERE product_id=:id"), {"id": product["id"]}).scalar()
                self.assertEqual(product["stock"], 10000 - sold)
            deleted = self.generator.delete_generated()
            self.assertEqual(deleted["total"], result["total"])
            self.assertEqual(self.snapshot(), self.baseline)
        self.assertEqual(self.generator.delete_generated()["total"], 0)

    def test_rollback_generation_and_deletion(self):
        def fail(value, message):
            if value >= 99:
                raise RuntimeError("Injected failure")
        with self.assertRaisesRegex(RuntimeError, "Injected failure"):
            self.generator.generate(15, fail)
        self.assertEqual(self.snapshot(), self.baseline)
        self.generator.generate(15)
        generated = self.snapshot()
        with self.assertRaises(RuntimeError):
            self.generator.delete_generated(fail)
        self.assertEqual(self.snapshot(), generated)
        self.generator.delete_generated()
        self.assertEqual(self.snapshot(), self.baseline)

    def test_protect_changed_and_reused_rows(self):
        self.generator.generate(3)
        customer_id = self.connection.scalar(select(owned.c.record_id).where(owned.c.table_name == "customers"))
        original_notes = self.connection.scalar(select(Customer.notes).where(Customer.id == customer_id))
        original_updated = self.connection.scalar(select(Customer.updated_at).where(Customer.id == customer_id))
        self.connection.execute(Customer.__table__.update().where(Customer.id == customer_id).values(notes="Now real user content"))
        before = self.snapshot()
        with self.assertRaisesRegex(SafetyError, "changed"):
            self.generator.delete_generated()
        self.assertEqual(self.snapshot(), before)
        self.connection.execute(Customer.__table__.update().where(Customer.id == customer_id).values(
            notes=original_notes, updated_at=original_updated))
        # Reused primary key in a table without AUTOINCREMENT must also be refused.
        task_id = self.connection.scalar(select(owned.c.record_id).where(owned.c.table_name == "tasks"))
        self.connection.execute(Task.__table__.delete().where(Task.id == task_id))
        self.connection.execute(Task.__table__.insert().values(id=task_id, date=datetime.now().date(), title="Real replacement task"))
        before = self.snapshot()
        with self.assertRaisesRegex(SafetyError, "tasks"):
            self.generator.delete_generated()
        self.assertEqual(self.snapshot(), before)

    def test_protect_real_references_including_cascade(self):
        self.generator.generate(3)
        member_id = self.connection.scalar(select(owned.c.record_id).where(owned.c.table_name == "members"))
        self.connection.execute(Attendance.__table__.insert().values(member_id=member_id,
            date=datetime.now().date() - timedelta(days=100), status="absent", recorded_time=datetime.now().time()))
        before = self.snapshot()
        with self.assertRaisesRegex(SafetyError, "Real attendance"):
            self.generator.delete_generated()
        self.assertEqual(self.snapshot(), before)

    def test_restricting_fk_and_multiple_batches(self):
        first = self.generator.generate(3)
        second = self.generator.generate(4)
        product_id = self.connection.scalar(select(owned.c.record_id).where(owned.c.table_name == "products"))
        # Unowned order item referencing a synthetic product must block deletion.
        order_id = self.connection.scalar(select(Order.id).order_by(Order.id.desc()))
        result = self.connection.execute(OrderItem.__table__.insert().values(order_id=order_id,
            product_id=product_id, position=99, product_name="Real item", unit="عدد", quantity=1, unit_price=10))
        before = self.snapshot()
        with self.assertRaisesRegex(SafetyError, "Real order_items"):
            self.generator.delete_generated()
        self.assertEqual(self.snapshot(), before)
        self.connection.execute(OrderItem.__table__.delete().where(OrderItem.id == result.inserted_primary_key[0]))
        self.assertEqual(self.generator.delete_generated()["total"], first["total"] + second["total"])
        self.assertEqual(self.snapshot(), self.baseline)

    def test_real_rows_and_missing_generated_record(self):
        # An unmarked record with a TEST-looking title is still real.
        result = self.connection.execute(Task.__table__.insert().values(date=datetime.now().date(), title="TEST real task"))
        baseline = self.snapshot()
        generated = self.generator.generate(3)
        task_id = self.connection.scalar(select(owned.c.record_id).where(owned.c.table_name == "tasks"))
        self.connection.execute(Task.__table__.delete().where(Task.id == task_id))
        self.assertEqual(self.generator.delete_generated()["total"], generated["total"] - 1)
        self.assertEqual(self.snapshot(), baseline)
        self.assertIsNotNone(self.connection.scalar(select(Task.id).where(Task.id == result.inserted_primary_key[0])))

    def test_invalid_quantity(self):
        for value in (0, -1, 100001, True, 1.5, "1000"):
            with self.assertRaises(ValueError):
                self.generator.generate(value)
        self.assertEqual(self.snapshot(), self.baseline)

    def test_respect_deleted_autoincrement_ids(self):
        maximum = self.connection.scalar(select(text("COALESCE(MAX(id), 0)")).select_from(Customer))
        high = maximum + 10000
        self.connection.execute(text("UPDATE sqlite_sequence SET seq=:seq WHERE name='customers'"), {"seq": high})
        if not self.connection.execute(text("SELECT 1 FROM sqlite_sequence WHERE name='customers'")).first():
            self.connection.execute(text("INSERT INTO sqlite_sequence(name, seq) VALUES ('customers', :seq)"), {"seq": high})
        self.generator.generate(1)
        generated_id = self.connection.scalar(select(owned.c.record_id).where(owned.c.table_name == "customers"))
        self.assertGreater(generated_id, high)
        self.generator.delete_generated()
        self.assertEqual(self.snapshot(), self.baseline)

    def test_full_reset_and_exact_generation_counts(self):
        # Explicitly include real/unmarked data and cascading biometric tables.
        self.connection.execute(Task.__table__.insert().values(
            date=datetime.now().date(), title="Unmarked real task"))
        self.generator.generate(4)
        member_id = self.connection.scalar(select(owned.c.record_id).where(owned.c.table_name == "members"))
        from models.member_face import MemberFace, MemberFacePhoto
        self.connection.execute(MemberFace.__table__.insert().values(
            member_id=member_id, encrypted_template=b"test encrypted placeholder", consented_at=datetime.now()))
        self.connection.execute(MemberFacePhoto.__table__.insert().values(
            member_id=member_id, angle="front", encrypted_image=b"test photo placeholder"))
        customer_id = self.connection.scalar(select(owned.c.record_id).where(owned.c.table_name == "customers"))
        self.connection.execute(Customer.__table__.update().where(Customer.id == customer_id).values(notes="Edited by user"))

        for quantity in (3, 7):
            before = self.snapshot()
            result = self.generator.delete()
            self.assertEqual(result["total"], sum(len(rows) for name, rows in before.items()
                if name not in {"users", "bank_directory", owned.name}))
            after = self.snapshot()
            for name, rows in after.items():
                self.assertEqual(rows, before[name] if name in {"users", "bank_directory"} else [], name)
            report = self.report()
            self.assertEqual(report["finance"], dict(income="0", expense="0", net="0", transactions=0))
            self.assertEqual(report["customers"]["total"], 0)
            self.assertEqual(report["customers"]["debtor_count"], 0)
            self.assertEqual(report["orders"]["total"], 0)
            self.assertEqual(report["orders"]["outstanding"], "0")
            self.assertEqual(report["inventory"]["products"], [])
            self.assertEqual(report["inventory"]["value"], "0")
            self.assertEqual(report["banks"]["items"], [])
            self.assertEqual(report["banks"]["balance"], "0")
            self.assertEqual(report["tasks"]["total"], 0)
            self.assertEqual(report["attendance"]["members"], 0)
            self.assertEqual(report["documents"]["total"], 0)
            generated = self.generator.generate(quantity)
            self.assertEqual(generated["counts"]["customers"], quantity)
            self.assertEqual(self.report()["customers"]["total"], quantity)
            self.assertEqual(self.report()["orders"]["total"], quantity)
        self.generator.delete()
        self.assertEqual(self.generator.delete()["total"], 0)
        self.assertEqual(self.connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])

    def test_full_reset_failure_rolls_back_real_and_generated_data(self):
        self.connection.execute(Task.__table__.insert().values(
            date=datetime.now().date(), title="Real task to preserve on failure"))
        self.generator.generate(5)
        before = self.snapshot()
        def fail(value, message):
            if value >= 99:
                raise RuntimeError("Reset failure")
        with self.assertRaisesRegex(RuntimeError, "Reset failure"):
            self.generator.delete(fail)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
