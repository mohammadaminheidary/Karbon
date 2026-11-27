from datetime import date
from typing import Literal
from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy.orm import Session
from database import get_database, read_snapshot
from security.auth import get_current_user
from routes.finance import finance_errors
from schemas.finance_schema import FinanceDelete
from schemas.order_schema import ProductEdit, ProductWrite
from schemas.inventory_schema import (
    InventoryCategoryWrite, InventoryNameWrite, PurchaseEdit, PurchasePaymentEdit, PurchasePaymentWrite, PurchaseWrite,
    WarehouseProductsDelete,
)
from services import inventory_service as service, invoice_settings_service as design
from services import purchase_payments
from services.order_service import save_product
from services.inventory_stock import inventory_movements, movement_summary
from services.fiscal_period import active_period, effective_day, jalali

router = APIRouter(prefix="/api/settings/inventory-options", tags=["Inventory settings"], dependencies=[Depends(get_current_user)])
OptionKind = Literal["categories", "units", "warehouse-categories"]
CategoryKind = Literal["categories", "warehouse-categories"]
purchase_router = APIRouter(prefix="/api/purchases", tags=["Purchases"], dependencies=[Depends(get_current_user)])
brand_router = APIRouter(prefix="/api/settings/brands", tags=["Inventory settings"], dependencies=[Depends(get_current_user)])
stock_router = APIRouter(prefix="/api/inventory", tags=["Inventory"], dependencies=[Depends(get_current_user)])


@stock_router.get("/products")
def warehouse_products(catalog_only: bool = False, db: Session = Depends(get_database)):
    return service.warehouse_products(db, catalog_only)


@stock_router.post("/products", status_code=201)
def create_warehouse_product(data: ProductWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return save_product(db, data, catalog="warehouse")


@stock_router.put("/products/{product_id}")
def edit_warehouse_product(data: ProductEdit, product_id: int = Path(gt=0, le=9223372036854775807),
                           db: Session = Depends(get_database)):
    with finance_errors():
        return save_product(db, data, product_id, catalog="warehouse")


@stock_router.delete("/products/{product_id}")
def remove_warehouse_product(data: FinanceDelete, product_id: int = Path(gt=0, le=9223372036854775807),
                             db: Session = Depends(get_database), user=Depends(get_current_user)):
    with finance_errors():
        service.remove_warehouse_products(db, [product_id], data, user)
        return {"id": product_id, "removed": True}


@stock_router.delete("/products")
def remove_warehouse_products(data: WarehouseProductsDelete, db: Session = Depends(get_database),
                              user=Depends(get_current_user)):
    with finance_errors():
        return service.remove_warehouse_products(db, data.product_ids, data, user)


@stock_router.get("/movements")
def movements(product_id: int | None = Query(None, gt=0, le=9223372036854775807),
              skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100), db: Session = Depends(get_database)):
    with finance_errors():
        return inventory_movements(db, product_id, skip, limit)


@stock_router.get("/today")
def inventory_today(db: Session = Depends(get_database)):
    with finance_errors():
        return movement_summary(db, effective_day(active_period(db)))


@brand_router.get("")
def brands(db: Session = Depends(get_database)):
    return service.list_brands(db)


@brand_router.post("", status_code=201)
def add_brand(data: InventoryNameWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_brand(db, data)


@brand_router.put("/{brand_id}")
def edit_brand(data: InventoryNameWrite, brand_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_brand(db, data, brand_id)


@brand_router.delete("/{brand_id}")
def delete_brand(brand_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.delete_brand(db, brand_id)


@purchase_router.get("")
def purchase_invoices(search: str = Query("", max_length=200), skip: int = Query(0, ge=0),
                      limit: int = Query(20, ge=1, le=100), history: bool = False, db: Session = Depends(get_database)):
    with finance_errors():
        read_snapshot(db)
        return service.list_purchase_invoices(db, search, skip, limit, history)


@purchase_router.get("/next-number")
def next_purchase(db: Session = Depends(get_database)):
    workflow = design.workflow_settings(db, "purchase")
    return {**workflow, "invoice_number": service.next_purchase_number(db) if workflow["numbering"]["legacy"] else None,
            "business_jalali": jalali(effective_day(active_period(db)))}


@purchase_router.get("/obligations")
def obligations(skip: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100),
                end_date: date | None = None,
                db: Session = Depends(get_database)):
    with finance_errors():
        read_snapshot(db)
        return purchase_payments.obligations(db, skip, limit, cutoff=end_date)


@purchase_router.get("/expenses")
def purchase_expenses(start_date: date, end_date: date, cursor: str | None = Query(None, max_length=512),
                      db: Session = Depends(get_database)):
    with finance_errors():
        read_snapshot(db)
        return purchase_payments.expense_report(db, start_date, end_date, cursor)


@purchase_router.post("", status_code=201)
def create_purchase(data: PurchaseWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_purchase(db, data)


@purchase_router.get("/{purchase_id}")
def purchase(purchase_id: int = Path(gt=0, le=9223372036854775807), for_edit: bool = False,
             db: Session = Depends(get_database)):
    with finance_errors():
        read_snapshot(db)
        return service.get_purchase(db, purchase_id, for_edit)


@purchase_router.put("/{purchase_id}")
def edit_purchase(data: PurchaseEdit, purchase_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_purchase(db, data, purchase_id)


@purchase_router.delete("/{purchase_id}")
def cancel_purchase(data: FinanceDelete, purchase_id: int = Path(gt=0, le=9223372036854775807),
                    db: Session = Depends(get_database), user=Depends(get_current_user)):
    with finance_errors():
        return service.cancel_purchase(db, purchase_id, data, user)


@purchase_router.get("/{purchase_id}/invoice")
def purchase_invoice(purchase_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        read_snapshot(db)
        return service.purchase_invoice(db, purchase_id)


@purchase_router.post("/{purchase_id}/payments", status_code=201)
def add_purchase_payment(data: PurchasePaymentWrite, purchase_id: int = Path(gt=0, le=9223372036854775807),
                         db: Session = Depends(get_database)):
    with finance_errors():
        return purchase_payments.save_payment(db, purchase_id, data)


@purchase_router.put("/{purchase_id}/payments/{payment_id}")
def edit_purchase_payment(data: PurchasePaymentEdit, purchase_id: int = Path(gt=0, le=9223372036854775807),
                          payment_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return purchase_payments.save_payment(db, purchase_id, data, payment_id)


@purchase_router.delete("/{purchase_id}/payments/{payment_id}")
def delete_purchase_payment(data: FinanceDelete, purchase_id: int = Path(gt=0, le=9223372036854775807),
                            payment_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database),
                            user=Depends(get_current_user)):
    with finance_errors():
        return purchase_payments.delete_payment(db, purchase_id, payment_id, data, user)


@router.get("")
def options(db: Session = Depends(get_database)):
    return service.list_options(db)


@router.post("/{kind}", status_code=201)
def add_option(kind: OptionKind, data: InventoryCategoryWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_option(db, kind, data)


@router.put("/{kind}/{option_id}")
def edit_option(kind: OptionKind, data: InventoryCategoryWrite, option_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_option(db, kind, data, option_id)


@router.delete("/{kind}/{option_id}")
def delete_category(kind: CategoryKind, option_id: int = Path(gt=0, le=9223372036854775807),
                    confirm_unassignment: bool = False, db: Session = Depends(get_database)):
    with finance_errors():
        return service.delete_category(db, option_id, kind, confirm_unassignment)
