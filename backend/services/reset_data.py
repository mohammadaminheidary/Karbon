"""Build a clean operational database while keeping Karbon's master data."""
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory

from sqlalchemy import create_engine

import config
from database import Base
from services.backup_service import database_connection, publish_snapshot, recovery_payload
from services.backup_settings import last_successful_backup
from services.database_setup import initialize_database
from services.fiscal_period import initialize_fiscal_storage


MASTER_TABLES = frozenset({
    "users", "members", "member_faces", "member_face_photos",
    "bank_directory", "bank_accounts", "expense_categories", "document_accounts", "backup_settings",
    "inventory_options", "brands", "products",
    "invoice_settings", "invoice_assets", "invoice_templates", "invoice_layout_versions", "invoice_template_defaults",
})


def copy_master_data(snapshot):
    tables = [table for table in Base.metadata.sorted_tables if table.name in MASTER_TABLES]
    with closing(database_connection(snapshot, must_exist=True)) as db, db:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("ATTACH DATABASE ? AS previous", (config.DATABASE_PATH.as_uri() + "?mode=ro",))
        for table in reversed(tables):
            db.execute(f"DELETE FROM main.{table.name}")
        for table in tables:
            columns = ", ".join(table.columns.keys())
            order = " ORDER BY parent_id IS NOT NULL" if table.name == "inventory_options" else ""
            db.execute(f"INSERT INTO main.{table.name} ({columns}) SELECT {columns} FROM previous.{table.name}{order}")
        db.execute("UPDATE main.products SET stock=0, revision=revision+1 WHERE stock != 0")
        db.execute("UPDATE main.bank_accounts SET opening_balance=0")
        # The fresh initializer ran before the catalog was copied. Rebuild only
        # the opening journal with the products that survived the reset.
        db.execute("DELETE FROM main.fiscal_inventory_history")
        if db.execute("PRAGMA main.foreign_key_check").fetchone():
            raise RuntimeError("Master data contains invalid references")


def reset_operational_data():
    zone = config.app_timezone()
    with TemporaryDirectory(prefix="karbon-reset-data-", ignore_cleanup_errors=True) as temporary:
        snapshot = Path(temporary) / "database.sqlite"
        staged = create_engine(f"sqlite:///{snapshot.as_posix()}")
        try:
            initialize_database(staged, zone=zone)
            copy_master_data(snapshot)
            initialize_fiscal_storage(staged, zone=zone)
        finally:
            staged.dispose()
        publish_snapshot(snapshot, recovery_payload(snapshot), last_backup_at=last_successful_backup())
