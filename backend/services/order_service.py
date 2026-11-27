import hashlib
import json
from datetime import date, datetime, timezone
from uuid import uuid5
import jdatetime
from sqlalchemy import String, cast, func, literal, or_, select, text
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateTable
from config import app_timezone
from models.customer import Customer
from models.finance import BankAccount, FinancialTransaction
from models.order import CASH_ACCOUNT_NUMBER, Product, Order, OrderItem, OrderPayment
from models.fiscal_year import InventoryChange
from services.finance_service import FinanceError, next_transaction_number, payment_bank, require, validate_receipt_reference
from services.fiscal_period import active_period, effective_day, ensure_open, in_active_period, jalali
from services.inventory_stock import StockPosting, line_quantities, opposite, post_stock, quantities_for
from services.reference_codes import compact_transaction_numbers
from services.receivables import CUSTOMER_RECEIPT_METHOD, active_bounds, direct_receipts, general_allocations, invoice_positions
from schemas.customer_schema import normalize_text
from security.password import verify_password
from services.inventory_service import (
    category_path, enabled_unit_names, products_by_id, require_category,
    require_enabled_unit, with_category_names,
)
from services.production_service import has_production_stock, production_stock_products
from models.inventory import Brand, Purchase, PurchaseItem
from services import invoice_settings_service as design


def initialize_order_storage(engine):
    """Add fields to previous installations and freeze historical invoices once."""
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        for table, additions in {
            "products": {"product_code": "VARCHAR(32)", "revision": "INTEGER NOT NULL DEFAULT 1", "deleted_at": "DATETIME"},
            "orders": {"invoice_snapshot": "JSON", "edit_snapshot": "JSON", "deleted_at": "DATETIME",
                       "tax": "BIGINT NOT NULL DEFAULT 0", "shipping": "BIGINT NOT NULL DEFAULT 0"},
        }.items():
            columns = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({table})")}
            for column, sql_type in additions.items():
                if column not in columns:
                    connection.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}")
        connection.exec_driver_sql("UPDATE products SET product_code = 'P-' || printf('%06d', id) WHERE product_code IS NULL")
        connection.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ux_product_code ON products(product_code)")
        with Session(bind=connection) as db:
            for order in db.query(Order).filter(Order.invoice_snapshot.is_(None)).all():
                order.invoice_snapshot = build_invoice(db, order)
            db.flush()
        connection.exec_driver_sql("""CREATE TRIGGER IF NOT EXISTS permanent_invoice_code
            BEFORE UPDATE OF invoice_code ON orders
            WHEN OLD.invoice_code NOT LIKE 'pending-%' AND NEW.invoice_code IS NOT OLD.invoice_code
            BEGIN SELECT RAISE(ABORT, 'invoice code is permanent'); END""")
        connection.exec_driver_sql("""CREATE TRIGGER IF NOT EXISTS permanent_invoice_snapshot
            BEFORE UPDATE OF invoice_snapshot ON orders
            WHEN OLD.invoice_snapshot IS NOT NULL AND OLD.invoice_snapshot != 'null' AND NEW.invoice_snapshot IS NOT OLD.invoice_snapshot
            BEGIN SELECT RAISE(ABORT, 'final invoice is permanent'); END""")
    upgrade_product_constraints(engine)


def upgrade_product_constraints(engine):
    """Replace SQLite's legacy name and nonnegative-stock constraints in place."""
    with engine.connect() as connection:
        foreign_keys = connection.exec_driver_sql("PRAGMA foreign_keys").scalar()
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        try:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            migrated = connection.exec_driver_sql(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name='ux_products_name_brand'"
            ).scalar()
            if not migrated:
                sequence = connection.exec_driver_sql("SELECT seq FROM sqlite_sequence WHERE name='products'").scalar()
                definition = str(CreateTable(Product.__table__).compile(dialect=connection.dialect))
                connection.exec_driver_sql(definition.replace("CREATE TABLE products (", "CREATE TABLE products_migration (", 1))
                columns = ", ".join(Product.__table__.columns.keys())
                connection.exec_driver_sql(f"INSERT INTO products_migration ({columns}) SELECT {columns} FROM products")
                connection.exec_driver_sql("DROP TABLE products")
                connection.exec_driver_sql("ALTER TABLE products_migration RENAME TO products")
                if sequence is not None:
                    connection.exec_driver_sql("UPDATE sqlite_sequence SET seq=MAX(seq, ?) WHERE name='products'", (sequence,))
                    connection.exec_driver_sql("INSERT INTO sqlite_sequence (name, seq) SELECT 'products', ? "
                                               "WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='products')", (sequence,))
                for index in Product.__table__.indexes:
                    index.create(connection)
                connection.exec_driver_sql("CREATE INDEX ix_products_category_id ON products(category_id)")
                if connection.exec_driver_sql("PRAGMA foreign_key_check").first():
                    raise RuntimeError("Product migration violated a foreign key")
            connection.commit()
        finally:
            connection.rollback()
            connection.exec_driver_sql(f"PRAGMA foreign_keys={foreign_keys}")


def products(db, include_inactive=False, for_order=False):
    query = db.query(Product).filter(Product.deleted_at.is_(None))
    if not include_inactive:
        query = query.filter(Product.active.is_(True))
    units = {normalize_text(name) for name in enabled_unit_names(db)} if for_order else None
    referenced = {product_id for (product_id,) in db.query(OrderItem.product_id).join(Order, Order.id == OrderItem.order_id).filter(Order.deleted_at.is_(None)).distinct().all()}
    referenced.update(product_id for (product_id,) in db.query(Purchase.product_id).distinct().all())
    referenced.update(product_id for (product_id,) in db.query(PurchaseItem.product_id).distinct().all())
    referenced.update(db.scalars(production_stock_products().distinct()))
    query = with_category_names(query, Product.category_id).outerjoin(Product.brand).add_columns(Brand.name)
    return [{**product_data(item, name, parent_name, brand_name), "can_delete": item.id not in referenced}
            for item, name, parent_name, brand_name in query.order_by(Product.id)
            if units is None or normalize_text(item.unit) in units]


def product_data(item, name, parent_name, brand_name):
    return {**{column.name: getattr(item, column.name) for column in Product.__table__.columns},
            "category_path": category_path(name, parent_name), "brand_name": brand_name}


def save_product(db, data, product_id=None):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        item = require(db, Product, product_id, "کالا") if product_id is not None else Product()
        previous_stock = item.stock
        if product_id is not None and item.revision != data.revision:
            raise FinanceError("کالا یا موجودی تغییر کرده است. فهرست را بروزرسانی و دوباره ویرایش کنید.", 409)
        unit = require_enabled_unit(db, data.unit, current=item.unit if product_id is not None else None)
        category, parent = require_category(db, data.category_id, current=item.category_id if product_id is not None else None)
        # Legacy edits omit both fields and keep the product's saved brand.
        if product_id is not None and data.model_fields_set.isdisjoint({"requires_brand", "brand_id"}):
            brand = item.brand
        else:
            brand = db.get(Brand, data.brand_id) if data.requires_brand and data.brand_id is not None else None
            if data.requires_brand and brand is None:
                raise FinanceError("برند کالا را از تنظیمات انتخاب کنید.", 422)
            item.requires_brand = data.requires_brand
            item.brand_id = brand.id if brand else None
        duplicate = db.query(Product.id).filter_by(name=data.name, brand_id=brand.id if brand else None)
        if product_id is not None:
            duplicate = duplicate.filter(Product.id != product_id)
        if duplicate.first():
            raise FinanceError("کالایی با همین نام و برند قبلاً ثبت شده است.", 409)
        target_stock = data.stock if product_id is None or "stock" in data.model_fields_set else previous_stock
        if previous_stock is not None and target_stock is None and has_open_stock_operations(db, item.id):
            raise FinanceError("تا زمانی که عملیات قابل برگشت برای کالا وجود دارد، کنترل موجودی را نمی‌توان غیرفعال کرد.", 409)
        for key, value in data.model_dump(exclude={"revision", "unit", "category_id", "requires_brand", "brand_id", "price", "stock"}).items():
            setattr(item, key, value)
        if product_id is None or "price" in data.model_fields_set:
            item.price = data.price
        item.unit = unit
        item.category_id = category.id
        if product_id is not None:
            item.revision += 1
        db.add(item)
        db.flush()
        if product_id is None:
            item.product_code = f"P-{item.id:06d}"
            db.flush()
        if target_stock is not None or previous_stock is not None:
            post_stock(db, {item.id: item}, StockPosting(
                f"product:{item.id}:{item.revision}", effective_day(active_period(db)),
                {item.id: (target_stock or 0) - (previous_stock or 0)}), tracked=target_stock is not None)
        result = product_data(item, category.name, parent.name if parent else None, brand.name if brand else None)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def has_open_stock_operations(db, product_id):
    period = active_period(db)
    orders = db.query(Order.id).join(OrderItem).filter(
        OrderItem.product_id == product_id, Order.deleted_at.is_(None),
        ~db.query(InventoryChange.id).filter(
            InventoryChange.reference == func.coalesce(
                func.json_extract(Order.edit_snapshot, "$._edit.stock_reference"),
                'sale:' + cast(Order.id, String) + ':issue'),
            InventoryChange.product_id == product_id, InventoryChange.delta == 0,
        ).exists(),
    )
    purchases = db.query(Purchase.id).join(PurchaseItem).filter(
        PurchaseItem.product_id == product_id, Purchase.deleted_at.is_(None))
    if period:
        orders = orders.filter(Order.invoice_date >= period.start_date)
        purchases = purchases.filter(Purchase.purchase_date >= period.start_date)
    return orders.first() is not None or purchases.first() is not None or has_production_stock(db, product_id, period)


def delete_product(db, product_id, data, user):
    if not verify_password(data.password, user.password_hash):
        raise FinanceError("رمز حساب کاربری صحیح نیست.", 403)
    db.rollback()
    try:
        # Serialize with order creation so a product cannot acquire an order
        # reference between the dependency check and deletion.
        db.execute(text("BEGIN IMMEDIATE"))
        product = require(db, Product, product_id, "کالا", include_deleted=True)
        if product.deleted_at is not None:
            db.commit()
            return {"id": product_id, "deleted": True}
        if db.query(Purchase.id).filter_by(product_id=product.id).first() or db.query(PurchaseItem.id).filter_by(product_id=product.id).first():
            raise FinanceError("این کالا در خرید ثبت‌شده استفاده شده و قابل حذف نیست. می‌توانید آن را غیرفعال کنید.", 409)
        if db.query(OrderItem.id).join(Order, Order.id == OrderItem.order_id).filter(
                OrderItem.product_id == product.id, Order.deleted_at.is_(None)).first():
            raise FinanceError("این کالا در سفارش ثبت‌شده استفاده شده و قابل حذف نیست. می‌توانید آن را غیرفعال کنید.", 409)
        if has_production_stock(db, product.id):
            raise FinanceError("این کالا در تولید ثبت‌شده استفاده شده و قابل حذف نیست.", 409)
        if product.stock is not None:
            post_stock(db, {product.id: product}, StockPosting(
                f"product:{product.id}:delete", effective_day(active_period(db)), {product.id: -product.stock}),
                tracked=False, retiring=True)
        if db.query(OrderItem.id).filter(OrderItem.product_id == product.id).first():
            # Deleted invoices retain immutable history and foreign keys.
            product.deleted_at = datetime.now(timezone.utc)
            product.active = False
            product.revision += 1
        else:
            db.delete(product)
        db.commit()
        return {"id": product_id, "deleted": True}
    except Exception:
        db.rollback()
        raise


def next_number(db):
    number = (db.query(func.max(Order.id)).scalar() or 0) + 1001
    while db.query(Order.id).filter(Order.order_number == str(number)).first():
        number += 1
    return str(number)


def read_order_payments(db, orders, *, issued=False):
    order_ids = [order.id for order in orders]
    customers = {order.customer_id for order in orders}
    cutoff = date.max if issued else active_bounds()[1]
    payments = direct_receipts(cutoff).where(OrderPayment.order_id.in_(order_ids))
    if not issued:
        positions = invoice_positions(cutoff, customers)
        general = general_allocations(positions, cutoff, customers).where(positions.c.id.in_(order_ids))
        payments = payments.union_all(general.add_columns(literal(CUSTOMER_RECEIPT_METHOD).label("method")))
    rows = payments.subquery()
    grouped = {}
    for order_id, method, transaction, amount in db.execute(
        select(rows.c.order_id, rows.c.method, FinancialTransaction, rows.c.amount)
        .join(FinancialTransaction, FinancialTransaction.id == rows.c.transaction_id)
        .order_by(FinancialTransaction.id)
    ):
        grouped.setdefault(order_id, []).append((method, transaction, amount))
    return grouped


def read_order_relations(db, order, *, issued=False):
    customer = db.get(Customer, order.customer_id)
    items = db.query(OrderItem).filter(OrderItem.order_id == order.id).order_by(OrderItem.position).all()
    return customer, items, read_order_payments(db, [order], issued=issued).get(order.id, [])


def current_invoice_snapshot(order):
    return order.edit_snapshot or order.invoice_snapshot or {}


def serialize(db, order, *, loaded=None):
    customer, items, payments = read_order_relations(db, order) if loaded is None else loaded
    paid = sum(amount for _, _, amount in payments)
    total = order.total
    snapshot = current_invoice_snapshot(order)
    category_paths = {item["id"]: item["category_path"] for item in snapshot.get("items", [])
                      if "category_path" in item}
    return {
        **{column.name: getattr(order, column.name) for column in Order.__table__.columns if column.name not in {"request_fingerprint", "invoice_snapshot", "edit_snapshot", "deleted_at"}},
        "created_at": order.created_at.replace(tzinfo=timezone.utc),
        "jalali_date": jdatetime.date.fromgregorian(date=order.invoice_date).strftime("%Y/%m/%d"),
        "jalali_payment_date": jdatetime.date.fromgregorian(date=order.payment_date).strftime("%Y/%m/%d"),
        "customer_name": snapshot["customer"]["name"] if snapshot else f"{customer.first_name} {customer.last_name}",
        "total": total, "paid": paid, "remaining": max(total - paid, 0),
        "payment_status": "settled" if paid >= total else "partial" if paid else "unpaid",
        "items": [{**{column.name: getattr(item, column.name) for column in OrderItem.__table__.columns},
                   "category_path": category_paths.get(item.id), "total": item.quantity * item.unit_price} for item in items],
        "payments": [{"method": method, "transaction_id": transaction.id, "bank_id": transaction.bank_id,
                      "amount": amount, "jalali_date": jalali(transaction.transaction_date),
                      "tracking_number": transaction.tracking_number} for method, transaction, amount in payments],
    }


def build_invoice(db, order, presentation=None, delivery_address=None, *, loaded=None):
    if loaded is None:
        loaded = read_order_relations(db, order, issued=True)
    data = serialize(db, order, loaded=loaded)
    data["customer"] = design.party_data(loaded[0])
    catalog = db.query(OrderItem.id, Product.product_code).join(
        Product, Product.id == OrderItem.product_id,
    ).filter(OrderItem.order_id == order.id)
    products = {item_id: (code, category_path(name, parent_name))
                for item_id, code, name, parent_name in with_category_names(catalog, OrderItem.category_id)}
    for item in data["items"]:
        item["product_code"], item["category_path"] = products[item["id"]]
    if data["payments"]:
        bank_ids = {payment["bank_id"] for payment in data["payments"]}
        bank_names = dict(db.query(BankAccount.id, BankAccount.name).filter(BankAccount.id.in_(bank_ids)).all())
        for payment in data["payments"]:
            payment["account_name"] = bank_names[payment["bank_id"]]
    if delivery_address:
        data["delivery_address"] = delivery_address
    if presentation:
        data["presentation"] = presentation
    else:
        data["store"] = None
    data["version"] = 1
    return json.loads(json.dumps(data, default=str, ensure_ascii=False))


def invoice(db, order_id, *, include_deleted=False, include_balance=False):
    order = require(db, Order, order_id, "سفارش", include_deleted=include_deleted)
    if not order.invoice_snapshot:
        raise FinanceError("فاکتور نهایی آماده نیست.", 409)
    saved = design.with_presentation(db, {key: value for key, value in current_invoice_snapshot(order).items()
                                         if key not in {"_edit", "finance_rules"}})
    if include_balance:
        balances = invoice_positions(active_bounds()[1], [order.customer_id]).c
        balance = db.execute(select(balances.paid, balances.remaining).where(balances.id == order.id)).mappings().one_or_none()
        if balance is not None:
            return {**saved, "current_balance": dict(balance)}
    return saved


def order_details(db, order_id, *, editing=False):
    order = require(db, Order, order_id, "سفارش")
    saved = invoice(db, order_id)
    # Execution status and receipt allocations are always read live.
    details = serialize(db, order)
    issued_payments = {p["transaction_id"]: p.get("account_name") for p in saved["payments"]}
    bank_ids = {p["bank_id"] for p in details["payments"] if not issued_payments.get(p["transaction_id"])}
    bank_names = dict(db.query(BankAccount.id, BankAccount.name).filter(BankAccount.id.in_(bank_ids)).all()) if bank_ids else {}
    for payment in details["payments"]:
        payment["account_name"] = issued_payments.get(payment["transaction_id"]) or bank_names[payment["bank_id"]]
    result = {**saved, **details, "customer": saved["customer"], "items": saved["items"]}
    if editing:
        snapshot = current_invoice_snapshot(order)
        result.update(revision=snapshot.get("_edit", {}).get("revision", 0),
                      edit_finance=order_finance_rules(db, order, snapshot),
                      edit_payments=[p for p in saved["payments"] if p["transaction_id"] in {
                          tx.id for _, tx, _ in read_order_payments(db, [order], issued=True).get(order.id, [])
                      }])
    return result


def complete_order(db, order_id):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        order = require(db, Order, order_id, "سفارش")
        ensure_open(db, order.invoice_date)
        if not order.invoice_snapshot:
            raise FinanceError("فقط سفارش ثبت‌شده با فاکتور نهایی قابل تکمیل است.", 409)
        if order.status not in ("active", "completed"):
            raise FinanceError("وضعیت سفارش اجازه تکمیل را نمی‌دهد.", 409)
        # Repeated/concurrent completion is safe and changes no financial data.
        completed_now = order.status == "active"
        order.status = "completed"
        db.flush()
        result = order_details(db, order.id)
        db.commit()
        return {**result, "completed_now": completed_now}
    except Exception:
        db.rollback()
        raise


def reactivate_order(db, order_id):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        order = require(db, Order, order_id, "سفارش")
        ensure_open(db, order.invoice_date)
        if not order.invoice_snapshot:
            raise FinanceError("فقط سفارش ثبت‌شده با فاکتور نهایی قابل بازگشت است.", 409)
        if order.status not in ("active", "completed"):
            raise FinanceError("وضعیت سفارش اجازه بازگشت را نمی‌دهد.", 409)
        # Target-state assignment makes duplicate/concurrent retries harmless.
        # Invoice history, inventory and payments remain unchanged.
        order.status = "active"
        db.flush()
        result = order_details(db, order.id)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def base36(value):
    digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    result = ""
    while value:
        value, remainder = divmod(value, 36)
        result = digits[remainder] + result
    return result or "0"


def load_order_relations(db, orders):
    """Load the relationships for this page, including the legacy full response."""
    ids = [order.id for order in orders]
    customers = {item.id: item for item in db.query(Customer).filter(Customer.id.in_({order.customer_id for order in orders})).all()} if ids else {}
    items = {}
    if ids:
        for item in db.query(OrderItem).filter(OrderItem.order_id.in_(ids)).order_by(OrderItem.position).all():
            items.setdefault(item.order_id, []).append(item)
    payments = read_order_payments(db, orders) if ids else {}
    return {order.id: (customers[order.customer_id], items.get(order.id, []), payments.get(order.id, [])) for order in orders}


def filter_order_search(query, search, *extra_fields):
    fields = (Customer.first_name + " " + Customer.last_name,
              Order.invoice_code, Order.order_number, *extra_fields)
    return query.filter(or_(*(field.contains(search, autoescape=True) for field in fields)))


def list_orders(db, status, skip, limit, *, search=""):
    query = db.query(Order).filter(Order.deleted_at.is_(None), in_active_period(Order.invoice_date))
    counts = dict(query.with_entities(Order.status, func.count(Order.id)).group_by(Order.status).all())
    matches = query.filter(Order.status == status)
    search = normalize_text(search)
    if search:
        historical_name = func.coalesce(Order.edit_snapshot["customer"]["name"].as_string(),
                                        Order.invoice_snapshot["customer"]["name"].as_string())
        matches = filter_order_search(matches.join(Customer, Customer.id == Order.customer_id),
                                      search, historical_name)
    total = matches.with_entities(func.count(Order.id)).scalar() if search else counts.get(status, 0)
    orders = matches.order_by(Order.id.desc()).offset(skip).limit(limit).all() if skip < total else []
    loaded = load_order_relations(db, orders)
    return {"total_orders": sum(counts.values()), "active_orders": counts.get("active", 0),
            "total": total,
            "items": [serialize(db, order, loaded=loaded[order.id]) for order in orders]}


def list_invoices(db, search, skip, limit):
    query = db.query(Order).join(Customer, Customer.id == Order.customer_id).filter(
        Order.deleted_at.is_(None), in_active_period(Order.invoice_date))
    search = normalize_text(search)
    if search:
        query = filter_order_search(query, search, cast(Customer.customer_code, String))
    total = query.count()
    orders = query.order_by(Order.id.desc()).offset(skip).limit(limit).all()
    loaded = load_order_relations(db, orders)
    items = []
    for order in orders:
        customer = loaded[order.id][0]
        items.append({**serialize(db, order, loaded=loaded[order.id]), "customer": {
            "id": customer.id, "code": customer.customer_code,
            "name": f"{customer.first_name} {customer.last_name}",
        }})
    return {"items": items, "total": total}


def delete_invoice(db, order_id, data, user):
    if not verify_password(data.password, user.password_hash):
        raise FinanceError("رمز حساب کاربری صحیح نیست.", 403)
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        order = require(db, Order, order_id, "فاکتور", include_deleted=True)
        ensure_open(db, order.invoice_date)
        if order.deleted_at is None:
            deleted_at = datetime.now(timezone.utc)
            # Keep immutable invoice history and retry IDs, while removing every
            # linked receipt from the live ledger in the same transaction.
            receipts = db.query(FinancialTransaction).join(
                    OrderPayment, OrderPayment.transaction_id == FinancialTransaction.id,
            ).filter(OrderPayment.order_id == order.id).all()
            ensure_open(db, *(receipt.transaction_date for receipt in receipts))
            for receipt in receipts:
                receipt.deleted_at = deleted_at
                receipt.updated_at = deleted_at
            issued = quantities_for(db, stock_reference(order))
            products = {}
            for product_id in line_quantities(db.query(OrderItem).filter_by(order_id=order.id)):
                product = products[product_id] = require(db, Product, product_id, "کالا")
                if product_id not in issued and product.stock is not None:
                    raise FinanceError(f"برداشت اولیه «{product.name}» در سوابق قدیمی قابل تأیید نیست.", 409,
                                       code="UNATTRIBUTED_STOCK")
            post_stock(db, products, StockPosting(f"sale:{order.id}:cancel", order.invoice_date, opposite(issued)))
            order.deleted_at = deleted_at
            db.flush()
            compact_transaction_numbers(db)
            db.expire_all()
        db.commit()
        return {"id": order_id, "deleted": True}
    except Exception:
        db.rollback()
        raise


def stock_reference(order):
    return current_invoice_snapshot(order).get("_edit", {}).get("stock_reference", f"sale:{order.id}:issue")


def order_finance_rules(db, order, snapshot):
    if "finance_rules" in snapshot:
        return snapshot["finance_rules"]
    defaults = design.preferences(db).data["sale_finance"]
    return {**defaults, "shipping": order.shipping,
            "tax_enabled": bool(order.tax) and defaults["tax_enabled"]}


def add_receipt(db, order, customer, data, day, request_id, number, *, tracking_number=None):
    bank = payment_bank(db, data.method, data.bank_id)
    validate_receipt_reference(db, bank.id, day, tracking_number)
    label = {"pos": "کارت‌خوان", "cash": "نقدی", "transfer": "کارت‌به‌کارت"}[data.method]
    now = datetime.now(app_timezone())
    transaction = FinancialTransaction(
        request_id=request_id, transaction_number=number, kind="income", customer_id=customer.id,
        bank_id=bank.id, amount=data.amount, title=f"{customer.first_name} {customer.last_name}",
        account_code=str(customer.customer_code), description=f"فاکتور {order.invoice_code} · {label}",
        tracking_number=tracking_number, transaction_date=day, transaction_time=now.strftime("%H:%M:%S"), time_mode="auto",
    )
    db.add(transaction)
    db.flush()
    db.add(OrderPayment(order_id=order.id, transaction_id=transaction.id, method=data.method))
    return transaction.id


def settle_invoice(db, order_id, data):
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        order = require(db, Order, order_id, "فاکتور")
        prior = db.query(FinancialTransaction, OrderPayment).outerjoin(
            OrderPayment, OrderPayment.transaction_id == FinancialTransaction.id,
        ).filter(FinancialTransaction.request_id == str(data.request_id)).first()
        if prior:
            transaction, allocation = prior
            is_cash = db.get(BankAccount, transaction.bank_id).account_number == CASH_ACCOUNT_NUMBER
            if (not allocation or allocation.order_id != order_id or allocation.method != data.method
                    or transaction.deleted_at is not None or transaction.transaction_date != data.transaction_date
                    or transaction.amount != data.amount or transaction.tracking_number != data.tracking_number
                    or not (is_cash if data.method == "cash" else transaction.bank_id == data.bank_id)):
                raise FinanceError("شناسه درخواست قبلاً برای پرداخت دیگری استفاده شده است.", 409)
            transaction_id = transaction.id
        else:
            period = active_period(db)
            ensure_open(db, data.transaction_date)
            if period is None or order.invoice_date >= period.start_date:
                raise FinanceError("این مسیر برای پرداخت فاکتور سال‌های بسته‌شده است.", 409)
            if not period.start_date <= data.transaction_date <= period.end_date:
                raise FinanceError("تاریخ دریافت باید در سال مالی فعال باشد.", 422)
            positions = invoice_positions(period.end_date, [order.customer_id]).c
            outstanding = db.scalar(select(positions.remaining).where(positions.id == order.id))
            if data.amount > outstanding:
                raise FinanceError("مبلغ دریافتی از مانده فاکتور بیشتر است.", 409)
            customer = require(db, Customer, order.customer_id, "مشتری")
            transaction_id = add_receipt(db, order, customer, data, data.transaction_date,
                                         str(data.request_id), next_transaction_number(db), tracking_number=data.tracking_number)
            db.flush()
        details = serialize(db, order)
        db.commit()
        return {"transaction_id": transaction_id, "order_id": order_id, "outstanding": details["remaining"]}
    except Exception:
        db.rollback()
        raise


def order_item(order_id, position, item, product, previous=None):
    return OrderItem(order_id=order_id, product_id=product.id, position=position,
                     product_name=previous.product_name if previous else product.name,
                     brand_name=previous.brand_name if previous else product.brand.name if product.brand else None,
                     category_id=previous.category_id if previous else product.category_id,
                     unit=previous.unit if previous else product.unit,
                     quantity=item.quantity, unit_price=item.unit_price)


def edit_stock(db, order, old_quantities, quantities, catalog, day, revision):
    reference = stock_reference(order)
    if old_quantities == quantities and order.invoice_date == day:
        return reference
    previous = quantities_for(db, reference)
    for product_id in old_quantities:
        product = catalog[product_id]
        if product_id not in previous and product.stock is not None:
            raise FinanceError(f"برداشت اولیه «{product.name}» در سوابق قدیمی قابل تأیید نیست.", 409,
                               code="UNATTRIBUTED_STOCK")
    issued = {}
    for product_id, quantity in quantities.items():
        # Units sold before tracking was enabled must never be restored as stock.
        untracked = old_quantities[product_id] + previous.get(product_id, 0)
        issued[product_id] = -max(0, quantity - untracked) if catalog[product_id].stock is not None else 0
    prefix = f"sale:{order.id}:edit:{revision}"
    reference = f"{prefix}:issue"
    post_stock(db, catalog, StockPosting(f"{prefix}:reverse", order.invoice_date, opposite(previous)),
               StockPosting(reference, day, issued))
    return reference


def edit_order_payments(db, order, snapshot, customer, data, total):
    original_ids = {payment["transaction_id"] for payment in snapshot["payments"]}
    direct = read_order_payments(db, [order], issued=True).get(order.id, [])
    original = {method: tx for method, tx, _ in direct if tx.id in original_ids}
    additional = [tx for _, tx, _ in direct if tx.id not in original_ids]
    if additional and customer.id != order.customer_id:
        raise FinanceError("برای سفارش دارای دریافت‌های بعدی، تغییر مشتری مجاز نیست.", 409)
    if sum(p.amount for p in data.payments) + sum(tx.amount for tx in additional) > total:
        raise FinanceError("مجموع پرداخت‌ها نباید از مبلغ نهایی فاکتور بیشتر باشد.", 422)
    ensure_open(db, *(tx.transaction_date for tx in original.values()))
    now = datetime.now(timezone.utc)
    number = next_transaction_number(db) if any(p.method not in original for p in data.payments) else None
    payment_ids = set()
    for payment in data.payments:
        tx = original.pop(payment.method, None)
        if tx is None:
            payment_ids.add(add_receipt(
                db, order, customer, payment, data.payment_date,
                str(uuid5(data.request_id, f"{order.id}:{data.revision}:{payment.method}")), number))
            number += 1
            continue
        payment_ids.add(tx.id)
        bank_id = tx.bank_id if payment.method == "cash" or tx.bank_id == payment.bank_id else payment_bank(db, payment.method, payment.bank_id).id
        day = tx.transaction_date if data.payment_date == order.payment_date else data.payment_date
        if (tx.customer_id, tx.bank_id, tx.amount, tx.transaction_date) != (customer.id, bank_id, payment.amount, day):
            validate_receipt_reference(db, bank_id, day, tx.tracking_number, exclude_id=tx.id)
            if tx.customer_id != customer.id:
                tx.title = f"{customer.first_name} {customer.last_name}"
                tx.account_code = str(customer.customer_code)
            tx.customer_id, tx.bank_id, tx.amount, tx.transaction_date = customer.id, bank_id, payment.amount, day
            tx.updated_at = now
    for tx in original.values():
        tx.deleted_at = tx.updated_at = now
    db.flush()
    if original:
        compact_transaction_numbers(db)
    return [row for row in read_order_payments(db, [order], issued=True).get(order.id, []) if row[1].id in payment_ids]


def edit_order(db, order_id, data):
    values = data.model_dump(mode="json", exclude={"request_id", "invoice_settings_revision"})
    fingerprint = hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()
    request_id = str(data.request_id)
    db.rollback()
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        order = require(db, Order, order_id, "سفارش")
        snapshot = current_invoice_snapshot(order)
        if not snapshot:
            raise FinanceError("فاکتور نهایی آماده نیست.", 409)
        edit = snapshot.get("_edit", {})
        if edit.get("request_id") == request_id:
            if edit["fingerprint"] != fingerprint:
                raise FinanceError("شناسه درخواست قبلاً برای ویرایش دیگری استفاده شده است.", 409)
            result = order_details(db, order_id, editing=True)
            db.commit()
            return result
        if data.revision != edit.get("revision", 0) or data.invoice_number not in (None, order.invoice_code):
            raise FinanceError("سفارش تغییر کرده است. جزئیات سفارش را دوباره برای ویرایش باز کنید.", 409,
                               code="ORDER_CHANGED")
        ensure_open(db, order.invoice_date, data.invoice_date, data.payment_date if data.payments else data.invoice_date)
        number = data.order_number or order.order_number
        if number != order.order_number and db.query(Order.id).filter(Order.order_number == number).first():
            raise FinanceError("شماره سفارش تکراری است؛ شماره دیگری وارد کنید.", 409)
        customer = require(db, Customer, data.customer_id, "مشتری")
        old_customer_id = order.customer_id
        rules = order_finance_rules(db, order, snapshot)
        subtotal = sum(item.quantity * item.unit_price for item in data.items)
        discount = order.discount if data.discount is None else data.discount
        totals = design.calculate_totals(subtotal, rules, discount)
        if (subtotal, discount) == (order.subtotal, order.discount):
            totals.update(tax=order.tax, total=order.total)
        items = db.query(OrderItem).filter_by(order_id=order.id).order_by(OrderItem.position).all()
        old_quantities, quantities = line_quantities(items), line_quantities(data.items)
        catalog = products_by_id(db, old_quantities.keys() | quantities.keys())
        units = enabled_unit_names(db)
        for product_id, quantity in quantities.items():
            if quantity > old_quantities[product_id]:
                product = require(db, Product, product_id, "کالا", active=True)
                require_enabled_unit(db, product.unit, enabled=units)
        revision = data.revision + 1
        reference = edit_stock(db, order, old_quantities, quantities, catalog, data.invoice_date, revision)
        payments = edit_order_payments(db, order, snapshot, customer, data, totals["total"])
        previous_items = {item.product_id: item for item in items}
        saved_items = {item["product_id"]: item for item in snapshot["items"]}
        def line_values(rows):
            return [(row.product_id, row.quantity, row.unit_price) for row in rows]
        if line_values(items) != line_values(data.items):
            for item in items:
                db.delete(item)
            items = [order_item(order_id, position, item, catalog[item.product_id], previous_items.get(item.product_id))
                     for position, item in enumerate(data.items, 1)]
            db.add_all(items)
        order.order_number, order.customer_id = number, customer.id
        order.invoice_date, order.payment_date, order.description = data.invoice_date, data.payment_date, data.description
        for key in ("subtotal", "discount", "tax", "shipping"):
            setattr(order, key, totals[key])
        db.flush()
        amended = build_invoice(db, order, snapshot.get("presentation"), data.delivery_address,
                                loaded=(customer, items, payments))
        if customer.id == old_customer_id:
            amended["customer"] = snapshot["customer"]
        amended["customer_name"] = amended["customer"]["name"]
        for item in amended["items"]:
            previous = saved_items.get(item["product_id"])
            if previous:
                item.update(category_path=previous.get("category_path"), product_code=previous.get("product_code"))
        order.edit_snapshot = {**amended, "finance_rules": rules, "_edit": {
            "revision": revision, "request_id": request_id, "fingerprint": fingerprint, "stock_reference": reference}}
        db.flush()
        result = order_details(db, order_id, editing=True)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def save_order(db, data):
    excluded = {"request_id", "invoice_settings_revision"}
    values = data.model_dump(exclude=excluded, mode="json")
    fingerprint = hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()
    fingerprints = {fingerprint}
    if data.invoice_number is None and data.delivery_address is None:
        legacy = data.model_copy(update={"discount": data.discount or 0})
        fingerprints.add(hashlib.sha256(legacy.model_dump_json(exclude=excluded | {"invoice_number", "delivery_address"}).encode()).hexdigest())
    db.rollback()
    try:
        # All validation, stock changes and ledger entries share the write lock.
        db.execute(text("BEGIN IMMEDIATE"))
        prior = db.query(Order).filter(Order.request_id == str(data.request_id)).first()
        if prior:
            if prior.deleted_at is not None:
                raise FinanceError("این فاکتور حذف شده است؛ برای سفارش جدید شناسه درخواست تازه ایجاد کنید.", 409)
            if prior.request_fingerprint not in fingerprints:
                raise FinanceError("شناسه درخواست قبلاً برای فاکتور دیگری استفاده شده است.", 409)
            result = serialize(db, prior)
            db.commit()
            return result
        ensure_open(db, data.invoice_date, data.payment_date if data.payments else data.invoice_date)
        customer = require(db, Customer, data.customer_id, "مشتری")
        settings = design.preferences(db)
        design.check_workflow_revision(settings, data.invoice_settings_revision)
        totals = design.calculate_totals(sum(item.quantity * item.unit_price for item in data.items),
                                         settings.data["sale_finance"], data.discount)
        if sum(payment.amount for payment in data.payments) > totals["total"]:
            raise FinanceError("مجموع پرداخت‌ها نباید از مبلغ نهایی فاکتور بیشتر باشد.", 422)
        quantities = line_quantities(data.items)
        catalog = products_by_id(db, quantities)
        units = enabled_unit_names(db)
        for product_id in quantities:
            # The batch holds these records in the session identity map.
            product = require(db, Product, product_id, "کالا", active=True)
            require_enabled_unit(db, product.unit, enabled=units)
        number = data.order_number or next_number(db)
        if data.order_number and db.query(Order.id).filter(Order.order_number == number).first():
            raise FinanceError("شماره سفارش تکراری است؛ شماره دیگری وارد کنید.", 409)
        order = Order(request_id=str(data.request_id), request_fingerprint=fingerprint,
                      invoice_code=f"pending-{data.request_id.hex[:24]}", order_number=number,
                      customer_id=customer.id, invoice_date=data.invoice_date, payment_date=data.payment_date,
                      description=data.description, **{key: value for key, value in totals.items() if key != "total"})
        db.add(order)
        db.flush()
        issued = {product_id: -quantity if catalog[product_id].stock is not None else 0
                  for product_id, quantity in quantities.items()}
        post_stock(db, catalog, StockPosting(f"sale:{order.id}:issue", data.invoice_date, issued))
        now = datetime.now(app_timezone())
        code_date = jdatetime.date.fromgregorian(date=now.date()).strftime("%Y%m%d")
        def legacy_number():
            return f"{code_date}-{now:%H%M%S}-{base36(order.id)}"
        order.invoice_code = design.allocate_number(db, "sale", settings.data["sale_numbering"], data.invoice_date,
                                                    data.invoice_number, Order.invoice_code, legacy_number)
        for position, item in enumerate(data.items, 1):
            product = catalog[item.product_id]
            db.add(order_item(order.id, position, item, product))
        if data.payments:
            number = next_transaction_number(db)
            for index, payment in enumerate(data.payments):
                add_receipt(db, order, customer, payment, data.payment_date,
                            str(uuid5(data.request_id, payment.method)), number + index)
        db.flush()
        loaded = read_order_relations(db, order, issued=True)
        order.invoice_snapshot = {**build_invoice(db, order, design.freeze_presentation(db, "sale", settings.data),
                                                  delivery_address=data.delivery_address, loaded=loaded),
                                  "finance_rules": settings.data["sale_finance"]}
        db.flush()
        customer, items, _ = loaded
        result = serialize(db, order, loaded=(customer, items, read_order_payments(db, [order]).get(order.id, [])))
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise
