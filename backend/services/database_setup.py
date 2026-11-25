"""Initialize Karbon data and default catalogs for startup and factory reset."""
from database import Base
from services.invoice_settings_service import initialize_invoice_storage
from services.finance_service import initialize_bank_storage
from services.order_service import initialize_order_storage
from services.inventory_service import initialize_brand_storage, initialize_category_storage, initialize_unit_storage, initialize_purchase_storage
from services.document_service import initialize_document_storage
from services.customer_ids import initialize_customer_ids
from services.auth_settings import initialize_auth_storage
from services.fiscal_period import initialize_fiscal_storage


def initialize_database(engine, *, zone=None):
    Base.metadata.create_all(bind=engine)
    initialize_auth_storage(engine)
    initialize_customer_ids(engine)
    initialize_bank_storage(engine)
    initialize_document_storage(engine)
    initialize_category_storage(engine)
    initialize_brand_storage(engine)
    initialize_purchase_storage(engine)
    initialize_invoice_storage(engine)
    initialize_order_storage(engine)
    initialize_unit_storage(engine)
    initialize_fiscal_storage(engine, zone=zone)
