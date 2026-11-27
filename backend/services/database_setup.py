"""Initialize Karbon data and default catalogs for startup and factory reset."""
from database import Base
from models.factory_reset import upgrade_factory_reset_challenges

from services.invoice_settings_service import initialize_invoice_storage
from services.finance_service import initialize_bank_storage
from services.order_service import initialize_order_storage
from services.inventory_service import initialize_brand_storage, initialize_category_storage, initialize_unit_storage, initialize_purchase_storage
from services.document_service import initialize_document_storage
from services.customer_ids import initialize_customer_ids
from services.default_customer import initialize_default_customer
from services.auth_settings import initialize_auth_storage
from services.fiscal_period import initialize_fiscal_storage


def initialize_database(engine, *, zone=None):
    Base.metadata.create_all(bind=engine)
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        upgrade_factory_reset_challenges(connection)
    initialize_auth_storage(engine)
    initialize_customer_ids(engine)
    initialize_default_customer(engine)
    initialize_bank_storage(engine)
    initialize_document_storage(engine)
    initialize_category_storage(engine)
    initialize_brand_storage(engine)
    initialize_purchase_storage(engine)
    initialize_invoice_storage(engine)
    initialize_order_storage(engine)
    initialize_unit_storage(engine)
    initialize_fiscal_storage(engine, zone=zone)
