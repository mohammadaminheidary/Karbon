"""Migration, collision, durability and database guards on disposable databases."""
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class CustomerIDTests(unittest.TestCase):
    def test_deleted_id_reused_after_restart_and_active_duplicates_rejected(self):
        with tempfile.TemporaryDirectory(prefix="karbon-customer-id-reuse-") as directory:
            database = Path(directory) / "test.db"
            self.run_script(database, r'''
import app
from datetime import datetime, timezone
from unittest.mock import patch
from sqlalchemy import text
from database import SessionLocal
from schemas.customer_schema import CustomerWrite
from services.customer_service import save_customer, delete_customer
with SessionLocal() as db:
    with patch('services.customer_service.utc_now', return_value=datetime(2026,10,30,12,tzinfo=timezone.utc)), \
         patch('services.customer_ids.secrets.choice', side_effect=list('AAAA')):
        customer = save_customer(db, CustomerWrite(first_name='original', last_name='customer'))
    assert customer['permanent_id'] == '080805-153000-AAAA'
    delete_customer(db, customer['id'])
    assert not db.execute(text('SELECT 1 FROM customer_id_registry')).first()
''')
            self.run_script(database, r'''
import app
from datetime import datetime, timezone
from unittest.mock import patch
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from database import engine, SessionLocal
from schemas.customer_schema import CustomerWrite
from services.customer_service import save_customer
from services.customer_ids import initialize_customer_ids
from services.reference_codes import compact_customer_codes
clock = datetime(2026,10,30,12,tzinfo=timezone.utc)
with SessionLocal() as db:
    with patch('services.customer_service.utc_now', return_value=clock), \
         patch('services.customer_ids.secrets.choice', side_effect=list('AAAA')):
        reused = save_customer(db, CustomerWrite(first_name='replacement', last_name='customer'))
    assert reused['permanent_id'] == '080805-153000-AAAA'
    with patch('services.customer_service.utc_now', return_value=clock), \
         patch('services.customer_ids.secrets.choice', side_effect=list('AAAABBBB')):
        other = save_customer(db, CustomerWrite(first_name='other', last_name='customer'))
    assert other['permanent_id'] == '080805-153000-BBBB'
    # The actual partial unique index rejects duplicate active IDs even if
    # a caller uses INSERT OR IGNORE/REPLACE for registry claims.
    try:
        db.execute(text("""INSERT INTO customers(customer_code,first_name,last_name,phone_numbers,created_at,updated_at,permanent_id)
            VALUES (1003,'duplicate','test','[]',:now,:now,:code)"""), {'now': clock, 'code': reused['permanent_id']})
        db.commit()
    except IntegrityError:
        db.rollback()
    else:
        raise AssertionError('duplicate active ID accepted')
    # Soft-deleted rows keep their historical data while releasing the ID.
    db.execute(text('UPDATE customers SET deleted_at=:now, customer_code=-id WHERE id=:id'), {'now': clock, 'id': reused['id']})
    from services.reference_codes import compact_customer_codes
    compact_customer_codes(db)
    db.commit()
    assert not db.execute(text('SELECT 1 FROM customer_id_registry WHERE permanent_id=:code'), {'code': reused['permanent_id']}).first()
    db.rollback()
    with patch('services.customer_service.utc_now', return_value=clock), \
         patch('services.customer_ids.secrets.choice', side_effect=list('AAAA')):
        replacement = save_customer(db, CustomerWrite(first_name='soft replacement', last_name='customer'))
    assert replacement['permanent_id'] == reused['permanent_id']
    try:
        db.execute(text('UPDATE customers SET deleted_at=NULL WHERE id=:id'), {'id': reused['id']})
        db.commit()
    except IntegrityError:
        db.rollback()
    else:
        raise AssertionError('restored duplicate active ID accepted')
    # Hard-deleting the historical row must not release its replacement's ID.
    db.execute(text('DELETE FROM customers WHERE id=:id'), {'id': reused['id']})
    db.commit()
    initialize_customer_ids(engine)
    assert db.execute(text('SELECT COUNT(*) FROM customer_id_registry')).scalar_one() == 2
    assert db.execute(text('SELECT COUNT(*) FROM customers WHERE permanent_id=:code'), {'code': replacement['permanent_id']}).scalar_one() == 1
''')

    def test_jalali_date_padding_year_and_local_midnight(self):
        with tempfile.TemporaryDirectory(prefix="karbon-customer-id-dates-") as directory:
            self.run_script(Path(directory) / "test.db", r'''
import app
import jdatetime
from datetime import datetime, time, timezone
from unittest.mock import patch
from config import APP_TIMEZONE
from database import engine
from services.customer_ids import generate_customer_id
cases = [
    ((1403, 10, 12), time(16, 25, 30), '121003-162530-RT4H'),
    ((1403, 1, 2), time(3, 4, 5), '020103-030405-RT4H'),
    ((1405, 8, 8), time(0, 0, 1), '080805-000001-RT4H'),
    ((1403, 12, 30), time(23, 59, 59), '301203-235959-RT4H'),
]
with engine.connect() as connection:
    for jalali, clock, expected in cases:
        local = datetime.combine(jdatetime.date(*jalali).togregorian(), clock, APP_TIMEZONE)
        utc = local.astimezone(timezone.utc)
        # SQLite timestamps and timezone-aware timestamps have identical meaning.
        for timestamp in [utc, utc.replace(tzinfo=None).isoformat()]:
            with patch('services.customer_ids.secrets.choice', side_effect=list('RT4H')):
                code = generate_customer_id(connection, timestamp)
            assert code == expected, (timestamp, code, expected)
            assert len(code.split('-')[0]) == 6
''')

    def test_upgrade_preserves_data_and_releases_retired_ids(self):
        with tempfile.TemporaryDirectory(prefix="karbon-customer-id-time-upgrade-") as directory:
            database = Path(directory) / "test.db"
            self.run_script(database, r'''
from database import Base, engine
import models
from services.customer_ids import initialize_customer_ids
from unittest.mock import patch
Base.metadata.create_all(engine)
with engine.begin() as connection:
    for index, deleted_at in [(1, None), (2, '2026-10-31 12:00:00')]:
        connection.exec_driver_sql("""INSERT INTO customers
            (id,customer_code,first_name,last_name,phone_numbers,notes,created_at,updated_at,deleted_at,permanent_id)
            VALUES (?,?,'original','customer','["09121234567"]','keep notes',
                    '2026-10-30 12:00:00','2026-10-30 12:00:00',?,?)""",
            (index, 1001 if index == 1 else -2, deleted_at, f'301026-OLD{index}'))
    connection.exec_driver_sql("INSERT INTO customer_id_registry VALUES ('301026-OLD1'), ('301026-OLD2'), ('080805-153000-AAAA')")
    connection.exec_driver_sql("""CREATE TRIGGER customer_id_registry_no_delete BEFORE DELETE ON customer_id_registry
        BEGIN SELECT RAISE(ABORT, 'old permanent reservation'); END""")
    connection.exec_driver_sql("""CREATE TRIGGER customers_permanent_id_required BEFORE INSERT ON customers
        WHEN length(NEW.permanent_id) != 11 BEGIN SELECT RAISE(ABORT, 'old format'); END""")
    connection.exec_driver_sql("""CREATE TRIGGER customers_permanent_id_immutable BEFORE UPDATE OF permanent_id ON customers
        BEGIN SELECT RAISE(ABORT, 'immutable'); END""")
    before = connection.exec_driver_sql('SELECT * FROM customers ORDER BY id').all()
with patch('services.customer_ids.secrets.choice', side_effect=list('AAAABBBBCCCC')):
    initialize_customer_ids(engine)
with engine.connect() as connection:
    after = connection.exec_driver_sql('SELECT * FROM customers ORDER BY id').all()
    columns = list(connection.exec_driver_sql('SELECT * FROM customers LIMIT 0').keys())
    index = columns.index('permanent_id')
    assert [tuple(row[:index])+tuple(row[index+1:]) for row in before] == [tuple(row[:index])+tuple(row[index+1:]) for row in after]
    assert [row[index] for row in after] == ['080805-153000-AAAA', '080805-153000-BBBB']
    assert connection.exec_driver_sql('SELECT COUNT(*) FROM customer_id_registry').scalar_one() == 1
initialize_customer_ids(engine)
with engine.connect() as connection:
    assert connection.exec_driver_sql('SELECT * FROM customers ORDER BY id').all() == after
''')
            self.run_script(database, "import app")

    def run_script(self, database, script):
        result = subprocess.run([sys.executable, "-c", script], cwd=ROOT / "backend",
                                env=dict(os.environ, KARBON_DATABASE_PATH=str(database),
                                         KARBON_TIMEZONE="Asia/Tehran", KARBON_JWT_SECRET="customer-id-test"),
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_legacy_migration_restart_and_database_backup_restore(self):
        with tempfile.TemporaryDirectory(prefix="karbon-customer-ids-") as directory:
            database = Path(directory) / "legacy.db"
            with closing(sqlite3.connect(database)) as db, db:
                db.execute("""CREATE TABLE customers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_code INTEGER NOT NULL UNIQUE,
                    gender VARCHAR(10), first_name VARCHAR(100) NOT NULL, last_name VARCHAR(100) NOT NULL,
                    address TEXT, last_contact_date DATE, phone_numbers JSON NOT NULL, notes TEXT,
                    created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, deleted_at DATETIME)""")
                for index, created_at, deleted_at in [(1, "2021-06-21 12:00:00", None),
                                                       (2, "2025-12-31 22:00:00", None),
                                                       (3, "2022-03-20 12:00:00", "2023-01-01 00:00:00")]:
                    db.execute("INSERT INTO customers VALUES (?, ?, 'female', ?, 'legacy', 'address', '2021-06-20', ?, 'notes', ?, ?, ?)",
                               (index, 1000+index if not deleted_at else -index, f"Customer {index}", '["09121234567"]', created_at, created_at, deleted_at))
                original = db.execute("SELECT * FROM customers ORDER BY id").fetchall()
            # Two independent worker processes initialize the same legacy file.
            env = dict(os.environ, KARBON_DATABASE_PATH=str(database), KARBON_JWT_SECRET="customer-id-test")
            script = "from database import Base, engine; import models; Base.metadata.create_all(engine); from services.customer_ids import initialize_customer_ids; initialize_customer_ids(engine)"
            # Create the registry first as app startup does, then race migrations.
            self.run_script(database, "from database import Base, engine; import models; Base.metadata.create_all(engine)")
            workers = [subprocess.Popen([sys.executable, "-c", script], cwd=ROOT / "backend", env=env,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
            for worker in workers:
                _, stderr = worker.communicate(timeout=30)
                self.assertEqual(worker.returncode, 0, stderr.decode())
            with closing(sqlite3.connect(database)) as db:
                rows = db.execute("SELECT * FROM customers ORDER BY id").fetchall()
                self.assertEqual([row[:-1] for row in rows], original)
                codes = [row[-1] for row in rows]
                self.assertEqual(len(set(codes)), 3)
                for code, prefix in zip(codes, ["310300-163000", "111004-013000", "291200-153000"]):
                    self.assertRegex(code, rf"^{prefix}-[A-Z0-9]{{4}}$")
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
                with closing(sqlite3.connect(Path(directory) / "restored.db")) as restored:
                    db.backup(restored)
            # Actual process restart and initialization of a restored SQLite file.
            for path in [database, Path(directory) / "restored.db"]:
                self.run_script(path, "import app")
                with closing(sqlite3.connect(path)) as db:
                    self.assertEqual(db.execute("SELECT permanent_id FROM customers ORDER BY id").fetchall(), [(code,) for code in codes])
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM customer_id_registry").fetchone()[0], 2)

    def test_bulk_insert_retries_collisions_within_pending_batch(self):
        with tempfile.TemporaryDirectory(prefix="karbon-customer-id-batch-") as directory:
            self.run_script(Path(directory) / "test.db", r'''
import app
from datetime import datetime, timezone
from unittest.mock import patch
from database import SessionLocal
from models.customer import Customer
from services.customer_ids import CustomerIDExhausted
from services import customer_service as service
from schemas.customer_schema import CustomerWrite
with SessionLocal() as db:
    with patch('services.customer_ids.secrets.choice', side_effect=list('AAAABBBBAAAACCCC')):
        db.add_all([Customer(customer_code=1001+i, first_name=f'batch {i}', last_name='test',
                             created_at=datetime(2026,10,30,12,tzinfo=timezone.utc)) for i in range(3)])
        db.commit()
    assert [row.permanent_id for row in db.query(Customer).order_by(Customer.id)] == [
        '080805-153000-AAAA', '080805-153000-BBBB', '080805-153000-CCCC']
    # A broken random source must fail cleanly without a partial registration.
    with patch('services.customer_service.utc_now', return_value=datetime(2026,10,30,12,tzinfo=timezone.utc)), \
         patch('services.customer_ids.secrets.choice', return_value='A'):
        try:
            service.save_customer(db, CustomerWrite(first_name='failed', last_name='allocation'))
        except CustomerIDExhausted:
            pass
        else:
            raise AssertionError('expected safe allocation failure')
    assert db.query(Customer).count() == 3
''')

    def test_failed_migration_rolls_back_schema_and_customer_changes(self):
        with tempfile.TemporaryDirectory(prefix="karbon-customer-id-rollback-") as directory:
            self.run_script(Path(directory) / "test.db", r'''
from database import engine
from models.customer import CustomerIDRegistry
from services.customer_ids import initialize_customer_ids
with engine.begin() as connection:
    connection.exec_driver_sql('CREATE TABLE customers(id INTEGER PRIMARY KEY, created_at DATETIME NOT NULL, notes TEXT)')
    connection.exec_driver_sql("INSERT INTO customers VALUES (1, '2021-06-21 12:00:00', 'keep one'), (2, 'invalid date', 'keep two')")
CustomerIDRegistry.__table__.create(engine)
try:
    initialize_customer_ids(engine)
except ValueError:
    pass
else:
    raise AssertionError('expected invalid legacy date to stop migration')
with engine.connect() as connection:
    assert [row[1] for row in connection.exec_driver_sql('PRAGMA table_info(customers)')] == ['id', 'created_at', 'notes']
    assert connection.exec_driver_sql('SELECT * FROM customers ORDER BY id').all() == [
        (1, '2021-06-21 12:00:00', 'keep one'), (2, 'invalid date', 'keep two')]
    assert connection.exec_driver_sql('SELECT COUNT(*) FROM customer_id_registry').scalar_one() == 0
''')


if __name__ == "__main__":
    unittest.main()
