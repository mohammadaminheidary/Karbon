"""Jalali business periods and the SQLite invariants shared by write paths."""
from datetime import date, datetime, timedelta

import jdatetime
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from config import app_timezone
from models.document import Document
from models.finance import FinancialTransaction
from models.fiscal_year import FiscalBankOpening, FiscalExport, FiscalSnapshot, FiscalYear, InventoryChange, InventoryHistory
from models.inventory import ProductionRun, Purchase
from models.order import Order, Product


class FiscalPeriodError(Exception):
    pass


DATED_TABLES = (
    ("orders", "invoice_date"), ("financial_transactions", "transaction_date"),
    ("documents", "date"), ("purchases", "purchase_date"), ("production_runs", "production_date"),
)
DATED_CHILDREN = (
    ("order_items", "order_id", "orders", "invoice_date"),
    ("order_payments", "transaction_id", "financial_transactions", "transaction_date"),
    ("purchase_items", "purchase_id", "purchases", "purchase_date"),
    ("purchase_payments", "transaction_id", "financial_transactions", "transaction_date"),
)
OPENING_TABLES = ("fiscal_bank_openings", "fiscal_customer_openings",
                  "fiscal_invoice_openings", "fiscal_inventory_openings")
LOCK_ACTIONS = {"INSERT": ("NEW",), "UPDATE": ("OLD", "NEW"), "DELETE": ("OLD",)}


def jalali(day):
    return jdatetime.date.fromgregorian(date=day).strftime("%Y/%m/%d")


def year_of(day):
    return jdatetime.date.fromgregorian(date=day).year


def year_dates(year):
    return (jdatetime.date(year, 1, 1).togregorian(),
            jdatetime.date(year + 1, 1, 1).togregorian() - timedelta(days=1))


def business_today():
    return datetime.now(app_timezone()).date()


def active_period(db):
    return db.scalar(active_value(FiscalYear))


def active_value(column):
    return open_years(column).limit(1)


def open_years(column):
    # Reopening leaves the unused successor in place. The earliest open row
    # is the single active period, even after more than one step backward.
    return select(column).where(FiscalYear.closed_at.is_(None)).order_by(FiscalYear.year)


def effective_day(period, today=None):
    today = today or business_today()
    return min(max(today, period.start_date), period.end_date) if period else today


def ensure_open(db, *dates):
    if not dates:
        return
    start, parked = db.execute(select(active_value(FiscalYear.start_date).scalar_subquery(),
        open_years(FiscalYear.start_date).offset(1).limit(1).scalar_subquery())).one()
    if start and any(day < start for day in dates):
        raise FiscalPeriodError(f"تاریخ ثبت یا ویرایش نباید پیش از شروع سال مالی فعال ({jalali(start)}) باشد.")
    if parked and any(day >= parked for day in dates):
        raise FiscalPeriodError("ثبت یا ویرایش عملیات سال بعد پس از فعال‌سازی دوباره آن ممکن است.")


def in_active_period(column):
    return column.between(
        func.coalesce(active_value(FiscalYear.start_date).scalar_subquery(), date.min),
        func.coalesce(active_value(FiscalYear.end_date).scalar_subquery(), date.max),
    )


def bank_openings(db, year):
    return dict(db.execute(select(FiscalBankOpening.bank_id, FiscalBankOpening.balance)
                           .where(FiscalBankOpening.year == year)).all())


def locked_date_sql(column):
    years = "FROM fiscal_years WHERE closed_at IS NULL ORDER BY year"
    return (f"(COALESCE({column} < (SELECT start_date {years} LIMIT 1), 0)"
            f" OR COALESCE({column} >= (SELECT start_date {years} LIMIT 1 OFFSET 1), 0))")


def install_guards(connection):
    # Allocations use the receipt date, even when they reference an archived sale.
    dates = [(table, f"{{row}}.{column}") for table, column in DATED_TABLES]
    dates.extend((table, f"(SELECT {column} FROM {parent} WHERE id={{row}}.{foreign_key})")
                 for table, foreign_key, parent, column in DATED_CHILDREN)
    for table, column in dates:
        for action, rows in LOCK_ACTIONS.items():
            check = " OR ".join(locked_date_sql(column.format(row=row)) for row in rows)
            connection.exec_driver_sql(f"""
                CREATE TRIGGER IF NOT EXISTS fiscal_lock_{table}_{action.lower()}
                BEFORE {action} ON {table} WHEN {check}
                BEGIN SELECT RAISE(ABORT, 'closed fiscal period or inactive successor'); END
            """)
    for table in ("fiscal_snapshots", "fiscal_exports", *OPENING_TABLES):
        changes = ("UPDATE OF year, version, closed_at, digest, backup_filename, data"
                   if table == "fiscal_snapshots" else "UPDATE")
        for action, event in (("update", changes), ("delete", "DELETE")):
            # Opening rows are derived from the previous year's snapshot.
            # They can be discarded once that year has been reopened.
            condition = ("WHEN EXISTS (SELECT 1 FROM fiscal_years WHERE year = OLD.year - 1 AND closed_at IS NOT NULL)"
                         if action == "delete" and table in OPENING_TABLES else "")
            connection.exec_driver_sql(f"""
                CREATE TRIGGER IF NOT EXISTS fiscal_freeze_{table}_{action}
                BEFORE {event} ON {table} {condition}
                BEGIN SELECT RAISE(ABORT, 'immutable fiscal record'); END
            """)
    connection.exec_driver_sql("""
        CREATE TRIGGER IF NOT EXISTS fiscal_freeze_closed_year
        BEFORE UPDATE OF year, start_date, end_date ON fiscal_years
        BEGIN SELECT RAISE(ABORT, 'closed fiscal period'); END
    """)


def upgrade_snapshot_versions(connection):
    columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(fiscal_snapshots)")}
    if "version" in columns:
        return
    connection.exec_driver_sql("DROP INDEX IF EXISTS ux_fiscal_year_active")
    connection.exec_driver_sql("DROP TRIGGER IF EXISTS fiscal_freeze_closed_year")
    for table, *_ in (*DATED_TABLES, *DATED_CHILDREN):
        for action in LOCK_ACTIONS:
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS fiscal_lock_{table}_{action.lower()}")
    for table in OPENING_TABLES:
        connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS fiscal_freeze_{table}_delete")
    # Rebuild the two archive tables together. The old export FK follows the
    # renamed parent until both old tables are dropped, with FKs still enabled.
    connection.exec_driver_sql("ALTER TABLE fiscal_exports RENAME TO fiscal_exports_v1")
    connection.exec_driver_sql("ALTER TABLE fiscal_snapshots RENAME TO fiscal_snapshots_v1")
    FiscalSnapshot.__table__.create(connection)
    FiscalExport.__table__.create(connection)
    connection.exec_driver_sql("""
        INSERT INTO fiscal_snapshots (year, version, closed_at, export_status, digest, backup_filename, data)
        SELECT s.year, 1, y.closed_at, COALESCE(y.export_status, 'pending'), s.digest, s.backup_filename, s.data
        FROM fiscal_snapshots_v1 AS s JOIN fiscal_years AS y ON y.year = s.year
    """)
    connection.exec_driver_sql("""
        INSERT INTO fiscal_exports (year, version, kind, content)
        SELECT year, 1, kind, content FROM fiscal_exports_v1
    """)
    connection.exec_driver_sql("DROP TABLE fiscal_exports_v1")
    connection.exec_driver_sql("DROP TABLE fiscal_snapshots_v1")


def upgrade_inventory_references(connection):
    columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(fiscal_inventory_changes)")}
    if "posted_at" not in columns:
        connection.exec_driver_sql("ALTER TABLE fiscal_inventory_changes ADD COLUMN posted_at DATETIME")
    if "reference" not in columns:
        connection.exec_driver_sql("ALTER TABLE fiscal_inventory_changes ADD COLUMN reference VARCHAR(100)")
        # The legacy journal has no source IDs. A negative movement with no
        # tracking-state change came from a sale. Link only complete groups of
        # equal product, date and quantity, including voided invoices.
        connection.exec_driver_sql("""
            WITH order_quantities AS (
                SELECT o.id AS order_id, i.product_id, MAX(o.invoice_date, h.available_from) AS day,
                       -SUM(i.quantity) AS delta
                FROM orders o JOIN order_items i ON i.order_id = o.id
                CROSS JOIN fiscal_inventory_history h
                WHERE h.id = 1 GROUP BY o.id, i.product_id
            ), sales AS (
                SELECT *, ROW_NUMBER() OVER (PARTITION BY product_id, day, delta ORDER BY order_id) AS seq,
                       COUNT(*) OVER (PARTITION BY product_id, day, delta) AS size
                FROM order_quantities
            ), changes AS (
                SELECT *, ROW_NUMBER() OVER (PARTITION BY product_id, business_date, delta ORDER BY id) AS seq,
                       COUNT(*) OVER (PARTITION BY product_id, business_date, delta) AS size
                FROM fiscal_inventory_changes WHERE tracked IS NULL AND delta < 0
            ), matches AS (
                SELECT c.id, 'sale:' || s.order_id || ':issue' AS reference FROM changes c JOIN sales s
                  ON s.product_id = c.product_id AND s.day = c.business_date AND s.delta = c.delta
                 AND s.size = c.size AND s.seq = c.seq
            )
            UPDATE fiscal_inventory_changes AS c
            SET reference = COALESCE((SELECT reference FROM matches WHERE id = c.id), 'legacy:' || c.id)
        """)
    connection.exec_driver_sql("""CREATE UNIQUE INDEX IF NOT EXISTS ux_inventory_change_reference_product
        ON fiscal_inventory_changes(reference, product_id)""")
    connection.exec_driver_sql("""CREATE INDEX IF NOT EXISTS ix_inventory_change_product_id
        ON fiscal_inventory_changes(product_id, id)""")
    connection.exec_driver_sql("""CREATE TRIGGER IF NOT EXISTS inventory_change_requires_reference
        BEFORE INSERT ON fiscal_inventory_changes WHEN NEW.reference IS NULL OR NEW.reference = ''
        BEGIN SELECT RAISE(ABORT, 'missing inventory reference'); END""")
    for action in ("UPDATE", "DELETE"):
        connection.exec_driver_sql(f"""CREATE TRIGGER IF NOT EXISTS inventory_change_no_{action.lower()}
            BEFORE {action} ON fiscal_inventory_changes
            BEGIN SELECT RAISE(ABORT, 'inventory journal is append-only'); END""")
    if "scope" not in columns:
        connection.exec_driver_sql("""ALTER TABLE fiscal_inventory_changes ADD COLUMN scope VARCHAR(12)
            NOT NULL DEFAULT 'sales' CHECK (scope IN ('sales', 'warehouse'))""")
    connection.exec_driver_sql("""CREATE INDEX IF NOT EXISTS ix_inventory_change_scope_product
        ON fiscal_inventory_changes(scope, product_id)""")
    history_columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(fiscal_inventory_history)")}
    if "warehouse_available_from" not in history_columns:
        connection.exec_driver_sql("ALTER TABLE fiscal_inventory_history ADD COLUMN warehouse_available_from DATE")


def initialize_warehouse_journal(db, history, today):
    if history.warehouse_available_from is not None:
        return
    # Keep recorded purchase postings in both historical views. The original
    # entries still reconcile the pre-split sales balance.
    db.execute(text("""
        INSERT INTO fiscal_inventory_changes
            (scope, reference, posted_at, product_id, business_date, delta, tracked, name, product_code, unit)
        SELECT 'warehouse', 'warehouse:' || reference, posted_at, product_id, business_date,
               delta, tracked, name, product_code, unit
        FROM fiscal_inventory_changes WHERE scope='sales' AND reference GLOB 'purchase:*'
        ORDER BY id
    """))
    # Receipts predating the journal still provide their latest line quantities.
    for suffix, sign, deleted in (("apply", 1, ""), ("cancel", -1, "WHERE p.deleted_at IS NOT NULL")):
        reference = ("'warehouse:purchase:' || p.id || ':' || p.revision || ':apply'" if suffix == "apply"
                     else "'warehouse:purchase:' || p.id || ':cancel'")
        db.connection().exec_driver_sql(f"""
            INSERT INTO fiscal_inventory_changes
                (scope, reference, posted_at, product_id, business_date, delta, name, product_code, unit)
            SELECT 'warehouse', {reference}, p.created_at, i.product_id, p.purchase_date,
                   {sign} * SUM(i.quantity), i.product_name, product.product_code, i.unit
            FROM purchases p JOIN purchase_items i ON i.purchase_id=p.id
            JOIN products product ON product.id=i.product_id
            {deleted}
            GROUP BY p.id, i.product_id
            ON CONFLICT(reference, product_id) DO NOTHING
        """)
    # Opening adjustments carry forward the current balance exactly once, net
    # of the receipt history copied above.
    db.execute(text("""
        INSERT INTO fiscal_inventory_changes
            (scope, reference, product_id, business_date, delta, tracked, name, product_code, unit)
        SELECT 'warehouse', 'warehouse:opening', p.id, :today, COALESCE(p.stock, 0) - COALESCE(m.quantity, 0),
               1, p.name, p.product_code, p.unit
        FROM products p
        LEFT JOIN (SELECT product_id, SUM(delta) AS quantity FROM fiscal_inventory_changes
                   WHERE scope='warehouse' GROUP BY product_id) m ON m.product_id=p.id
        WHERE p.deleted_at IS NULL AND (p.stock IS NOT NULL OR m.product_id IS NOT NULL)
    """), {"today": today})
    first = db.scalar(select(func.min(InventoryChange.business_date)).where(InventoryChange.scope == "warehouse"))
    history.warehouse_available_from = min(today, first) if first else today


def split_product_catalogs(connection):
    if connection.exec_driver_sql("SELECT 1 FROM inventory_purchase_migrations WHERE version=4").scalar():
        return
    connection.exec_driver_sql("""
        INSERT INTO products
            (catalog, legacy_product_id, product_code, revision, name, unit, warehouse_category_id,
             requires_brand, brand_id, price, active)
        SELECT 'warehouse', p.id, 'W-' || printf('%06d', p.id), 1, p.name, p.unit, p.warehouse_category_id,
               p.requires_brand, p.brand_id, p.price, p.active
        FROM products p
        WHERE p.catalog='sales' AND p.deleted_at IS NULL AND (
            p.warehouse_category_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM purchases WHERE product_id=p.id)
            OR EXISTS (SELECT 1 FROM purchase_items WHERE product_id=p.id)
            OR EXISTS (SELECT 1 FROM fiscal_inventory_changes
                       WHERE scope='warehouse' AND product_id=p.id GROUP BY product_id HAVING SUM(delta) != 0)
        )
    """)
    # Rekey warehouse movements once. Keep original purchase documents and
    # the sales journal intact, including closed fiscal snapshots.
    connection.exec_driver_sql("DROP TRIGGER IF EXISTS inventory_change_no_update")
    connection.exec_driver_sql("""
        UPDATE fiscal_inventory_changes AS movement SET product_id = warehouse.id
        FROM products AS warehouse
        WHERE movement.scope='warehouse' AND warehouse.legacy_product_id=movement.product_id
    """)
    connection.exec_driver_sql("""CREATE TRIGGER inventory_change_no_update
        BEFORE UPDATE ON fiscal_inventory_changes
        BEGIN SELECT RAISE(ABORT, 'inventory journal is append-only'); END""")
    connection.exec_driver_sql("""
        UPDATE products SET warehouse_category_id=NULL WHERE id IN (
            SELECT legacy_product_id FROM products WHERE legacy_product_id IS NOT NULL)
    """)
    connection.exec_driver_sql("INSERT INTO inventory_purchase_migrations (version) VALUES (4)")


def initialize_fiscal_storage(engine, zone=None):
    with Session(engine) as db:
        db.execute(text("BEGIN IMMEDIATE"))
        upgrade_snapshot_versions(db.connection())
        upgrade_inventory_references(db.connection())
        if active_period(db):
            install_guards(db.connection())
        today = datetime.now(zone or app_timezone()).date()
        history = db.get(InventoryHistory, 1)
        if history is None:
            # The previous application kept a single mutable stock count. If
            # already affected by later business dates, it cannot be unwound.
            last_sale = db.scalar(select(func.max(Order.invoice_date)).where(Order.deleted_at.is_(None)))
            last_purchase = db.scalar(select(func.max(Purchase.purchase_date)))
            available_from = max(filter(None, (today, last_sale, last_purchase)))
            history = InventoryHistory(id=1, available_from=available_from)
            db.add(history)
            for product in db.scalars(select(Product).where(Product.deleted_at.is_(None), Product.catalog == "sales")):
                db.add(InventoryChange(reference="opening", product_id=product.id, business_date=available_from,
                                       delta=product.stock or 0, tracked=product.stock is not None,
                                       name=product.name, product_code=product.product_code, unit=product.unit))
        initialize_warehouse_journal(db, history, today)
        split_product_catalogs(db.connection())
        db.commit()


def observed_years(db):
    """Business records determine the first open year on a legacy database."""
    earliest = latest = year_of(business_today())
    for column, deleted in ((Order.invoice_date, Order.deleted_at),
                            (FinancialTransaction.transaction_date, FinancialTransaction.deleted_at),
                            (Document.date, Document.deleted_at), (Purchase.purchase_date, Purchase.deleted_at),
                            (ProductionRun.production_date, ProductionRun.deleted_at)):
        query = select(func.min(column), func.max(column))
        if deleted is not None:
            query = query.where(deleted.is_(None))
        first, last = db.execute(query).one()
        if first is not None:
            earliest, latest = min(earliest, year_of(first)), max(latest, year_of(last))
    return earliest, latest
