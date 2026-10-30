"""Customer IDs and the registry of IDs held by active customers.

Registration holds BEGIN IMMEDIATE before choosing a candidate. The database
insert trigger claims it atomically, including for writes outside the HTTP API.
"""
from datetime import datetime, timezone
import secrets
import string

import jdatetime
from sqlalchemy import text

from config import APP_TIMEZONE


ALPHABET = string.ascii_uppercase + string.digits
ID_GLOB = "[0-9]" * 6 + "-" + "[0-9]" * 6 + "-" + "[A-Z0-9]" * 4


class CustomerIDExhausted(Exception):
    pass


def generate_customer_id(connection, registered_at, *, pending=()):
    if isinstance(registered_at, str):
        registered_at = datetime.fromisoformat(registered_at)
    # SQLite stores UTC timestamps without their timezone marker.
    if registered_at.tzinfo is None:
        registered_at = registered_at.replace(tzinfo=timezone.utc)
    local = registered_at.astimezone(APP_TIMEZONE)
    registered_date = jdatetime.date.fromgregorian(date=local.date())
    # Build ASCII DDMMYY explicitly: a full Jalali year is four digits and
    # must never leak into the six-digit date portion of a permanent ID.
    prefix = (f"{registered_date.day:02d}{registered_date.month:02d}{registered_date.year % 100:02d}"
              f"-{local.hour:02d}{local.minute:02d}{local.second:02d}")
    for _ in range(256):
        candidate = prefix + "-" + "".join(secrets.choice(ALPHABET) for _ in range(4))
        if candidate in pending:
            continue
        if not connection.execute(text("""
            SELECT 1 FROM customer_id_registry WHERE permanent_id = :code
            UNION ALL SELECT 1 FROM customers WHERE permanent_id = :code AND deleted_at IS NULL LIMIT 1
        """), {"code": candidate}).first():
            return candidate
    # Fail safely rather than returning a duplicate or looping forever.
    raise CustomerIDExhausted("Could not allocate a unique customer ID")


def customer_id_default(context):
    # SQLAlchemy evaluates defaults for an entire insert batch before sending
    # its rows to SQLite. Also check candidates from that still-pending batch.
    pending = getattr(context, "_karbon_customer_ids", None)
    if pending is None:
        pending = context._karbon_customer_ids = set()
    code = generate_customer_id(
        context.connection, context.get_current_parameters()["created_at"],
        pending=pending,
    )
    pending.add(code)
    return code


def initialize_customer_ids(engine):
    """Transactional, additive and repeatable upgrade; never renumber customers."""
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(customers)")}
        if "permanent_id" not in columns:
            connection.exec_driver_sql("ALTER TABLE customers ADD COLUMN permanent_id VARCHAR(18)")
        if "deleted_at" not in columns:
            connection.exec_driver_sql("ALTER TABLE customers ADD COLUMN deleted_at DATETIME")
        # Replace the former permanent-reservation policy atomically. Retained
        # historical customer rows keep their IDs but no longer reserve them.
        for trigger in (
            "customers_permanent_id_immutable", "customers_permanent_id_required",
            "customers_permanent_id_never_reuse", "customers_permanent_id_claim",
            "customers_permanent_id_retain_on_delete", "customer_id_registry_no_delete",
            "customer_id_registry_no_update", "customers_permanent_id_release",
            "customers_permanent_id_soft_release", "customers_permanent_id_restore_guard",
            "customers_permanent_id_restore_claim",
        ):
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger}")
        connection.exec_driver_sql("DROP INDEX IF EXISTS ux_customers_permanent_id")
        connection.exec_driver_sql("CREATE UNIQUE INDEX ux_customers_permanent_id ON customers(permanent_id) WHERE deleted_at IS NULL")
        connection.exec_driver_sql("""
            DELETE FROM customer_id_registry WHERE NOT EXISTS (
                SELECT 1 FROM customers WHERE customers.permanent_id = customer_id_registry.permanent_id
                AND customers.deleted_at IS NULL)
        """)
        rows = connection.execute(text("""
            SELECT id, created_at FROM customers
            WHERE permanent_id IS NULL OR length(permanent_id) != 18
                  OR permanent_id NOT GLOB :pattern ORDER BY id
        """), {"pattern": ID_GLOB}).all()
        for customer_id, created_at in rows:
            permanent_id = generate_customer_id(connection, created_at)
            connection.execute(text("UPDATE customers SET permanent_id=:code WHERE id=:id"),
                               {"code": permanent_id, "id": customer_id})
        connection.exec_driver_sql("""
            INSERT INTO customer_id_registry(permanent_id)
            SELECT permanent_id FROM customers WHERE permanent_id IS NOT NULL AND deleted_at IS NULL
            ON CONFLICT DO NOTHING
        """)
        connection.exec_driver_sql("""
            DELETE FROM customer_id_registry WHERE NOT EXISTS (
                SELECT 1 FROM customers WHERE customers.permanent_id = customer_id_registry.permanent_id
                AND customers.deleted_at IS NULL)
        """)
        # Old SQLite tables cannot gain NOT NULL in place. These guards enforce
        # the same invariant without rebuilding a table referenced by invoices.
        connection.exec_driver_sql(f"""
            CREATE TRIGGER IF NOT EXISTS customers_permanent_id_required
            BEFORE INSERT ON customers
            WHEN NEW.permanent_id IS NULL OR length(NEW.permanent_id) != 18
                 OR NEW.permanent_id NOT GLOB '{ID_GLOB}'
            BEGIN SELECT RAISE(ABORT, 'invalid permanent customer ID'); END
        """)
        connection.exec_driver_sql("""
            CREATE TRIGGER IF NOT EXISTS customers_permanent_id_immutable
            BEFORE UPDATE OF permanent_id ON customers
            WHEN NEW.permanent_id IS NOT OLD.permanent_id
            BEGIN SELECT RAISE(ABORT, 'permanent customer ID is immutable'); END
        """)
        connection.exec_driver_sql("""
            CREATE TRIGGER customers_permanent_id_claim
            AFTER INSERT ON customers WHEN NEW.deleted_at IS NULL
            BEGIN INSERT INTO customer_id_registry(permanent_id) VALUES (NEW.permanent_id); END
        """)
        connection.exec_driver_sql("""
            CREATE TRIGGER customers_permanent_id_release
            AFTER DELETE ON customers WHEN OLD.deleted_at IS NULL
            BEGIN DELETE FROM customer_id_registry WHERE permanent_id = OLD.permanent_id; END
        """)
        connection.exec_driver_sql("""
            CREATE TRIGGER customers_permanent_id_soft_release
            AFTER UPDATE OF deleted_at ON customers
            WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
            BEGIN DELETE FROM customer_id_registry WHERE permanent_id = OLD.permanent_id; END
        """)
        connection.exec_driver_sql("""
            CREATE TRIGGER customers_permanent_id_restore_guard
            BEFORE UPDATE OF deleted_at ON customers
            WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
                 AND EXISTS (SELECT 1 FROM customer_id_registry WHERE permanent_id = NEW.permanent_id)
            BEGIN SELECT RAISE(ABORT, 'customer ID is already assigned'); END
        """)
        connection.exec_driver_sql("""
            CREATE TRIGGER customers_permanent_id_restore_claim
            AFTER UPDATE OF deleted_at ON customers
            WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
            BEGIN INSERT INTO customer_id_registry(permanent_id) VALUES (NEW.permanent_id); END
        """)
        connection.exec_driver_sql("""
            CREATE TRIGGER customer_id_registry_no_delete
            BEFORE DELETE ON customer_id_registry
            WHEN EXISTS (SELECT 1 FROM customers WHERE permanent_id = OLD.permanent_id AND deleted_at IS NULL)
            BEGIN SELECT RAISE(ABORT, 'active customer ID must remain registered'); END
        """)
        connection.exec_driver_sql("""
            CREATE TRIGGER customer_id_registry_no_update BEFORE UPDATE ON customer_id_registry
            BEGIN SELECT RAISE(ABORT, 'customer ID registry entries cannot be edited'); END
        """)
