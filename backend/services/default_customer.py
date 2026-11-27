"""Seed and protect the walk-in customer using the existing customer table."""
from sqlalchemy import select, update

from models.customer import Customer, DEFAULT_CUSTOMER_CODE


def initialize_default_customer(engine):
    customers = Customer.__table__
    first_name, last_name = "مشتری", "حضوری"
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        existing = connection.execute(select(
            customers.c.first_name, customers.c.last_name, customers.c.deleted_at,
        ).where(customers.c.customer_code == DEFAULT_CUSTOMER_CODE)).one_or_none()
        if existing is None:
            connection.execute(customers.insert().values(
                customer_code=DEFAULT_CUSTOMER_CODE, first_name=first_name, last_name=last_name,
            ))
        elif existing != (first_name, last_name, None):
            # Keep the internal ID, contact information and historical references.
            connection.execute(update(customers).where(customers.c.customer_code == DEFAULT_CUSTOMER_CODE)
                               .values(first_name=first_name, last_name=last_name, deleted_at=None))

        # Also protect writes that bypass the customer API. SQLite REPLACE can
        # delete conflicting rows without firing DELETE triggers.
        connection.exec_driver_sql(f"""
            CREATE TRIGGER IF NOT EXISTS customers_system_no_replace
            BEFORE INSERT ON customers
            WHEN NEW.customer_code = {DEFAULT_CUSTOMER_CODE} OR EXISTS (
                SELECT 1 FROM customers WHERE customer_code = {DEFAULT_CUSTOMER_CODE}
                AND (id = NEW.id OR permanent_id = NEW.permanent_id AND NEW.deleted_at IS NULL)
            )
            BEGIN SELECT RAISE(ABORT, 'system customer cannot be replaced'); END
        """)
        connection.exec_driver_sql(f"""
            CREATE TRIGGER IF NOT EXISTS customers_system_identity
            BEFORE UPDATE ON customers
            WHEN (OLD.customer_code = {DEFAULT_CUSTOMER_CODE} AND (
                    NEW.customer_code IS NOT OLD.customer_code OR NEW.id IS NOT OLD.id OR
                    NEW.first_name IS NOT OLD.first_name OR NEW.last_name IS NOT OLD.last_name OR
                    NEW.deleted_at IS NOT NULL
                )) OR (OLD.customer_code != {DEFAULT_CUSTOMER_CODE} AND (
                    NEW.customer_code = {DEFAULT_CUSTOMER_CODE} OR
                    (NEW.id IS NOT OLD.id AND EXISTS (
                        SELECT 1 FROM customers WHERE customer_code = {DEFAULT_CUSTOMER_CODE} AND id = NEW.id
                    ))
                ))
            BEGIN SELECT RAISE(ABORT, 'system customer identity is immutable'); END
        """)
        connection.exec_driver_sql(f"""
            CREATE TRIGGER IF NOT EXISTS customers_system_no_delete
            BEFORE DELETE ON customers WHEN OLD.customer_code = {DEFAULT_CUSTOMER_CODE}
            BEGIN SELECT RAISE(ABORT, 'system customer cannot be deleted'); END
        """)
