from typing import Literal
from fastapi import APIRouter, Depends, Query, Path
from sqlalchemy.orm import Session
from database import get_database, read_snapshot
from security.auth import get_current_user
from routes.finance import finance_errors
from schemas.order_schema import OrderWrite, OrderEdit, ProductWrite, ProductEdit, SettlementWrite
from schemas.finance_schema import FinanceDelete
from services import order_service as service, invoice_settings_service as design
from services.fiscal_period import active_period, effective_day, jalali

router = APIRouter(prefix="/api", tags=["Orders"], dependencies=[Depends(get_current_user)])


@router.get("/settings/invoices")
def invoices(search: str = Query("", max_length=200), skip: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100), db: Session = Depends(get_database)):
    with finance_errors():
        read_snapshot(db)
        return service.list_invoices(db, search, skip, limit)


@router.delete("/orders/{order_id}/invoice")
@router.delete("/orders/{order_id}")
def delete_invoice(data: FinanceDelete, order_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database), user=Depends(get_current_user)):
    with finance_errors():
        return service.delete_invoice(db, order_id, data, user)


@router.get("/products")
def products(include_inactive: bool = False, for_order: bool = False, db: Session = Depends(get_database)):
    with finance_errors():
        return service.products(db, include_inactive, for_order)


@router.put("/products/{product_id}")
def edit_product(data: ProductEdit, product_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_product(db, data, product_id)


@router.delete("/products/{product_id}")
def delete_product(data: FinanceDelete, product_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database), user=Depends(get_current_user)):
    with finance_errors():
        return service.delete_product(db, product_id, data, user)


@router.get("/orders/{order_id}/invoice")
def final_invoice(order_id: int = Path(gt=0, le=9223372036854775807), include_balance: bool = False,
                  db: Session = Depends(get_database)):
    with finance_errors():
        if include_balance:
            read_snapshot(db)
        return service.invoice(db, order_id, include_balance=include_balance)


@router.post("/orders/{order_id}/payments", status_code=201)
def settle_invoice(data: SettlementWrite, order_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.settle_invoice(db, order_id, data)


@router.post("/products", status_code=201)
def create_product(data: ProductWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_product(db, data)


@router.get("/orders/next-number")
def next_number(db: Session = Depends(get_database)):
    with finance_errors():
        return {"order_number": service.next_number(db), **design.workflow_settings(db, "sale"), "business_jalali": jalali(effective_day(active_period(db)))}


@router.get("/orders")
def orders(status: Literal["active", "completed"] = "active", skip: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100),
           search: str = Query("", max_length=200), db: Session = Depends(get_database)):
    with finance_errors():
        read_snapshot(db)
        return service.list_orders(db, status, skip, limit, search=search)


@router.post("/orders", status_code=201)
def create_order(data: OrderWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_order(db, data)


@router.get("/orders/{order_id}")
def order_details(order_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        read_snapshot(db)
        return service.order_details(db, order_id, editing=True)


@router.put("/orders/{order_id}")
def edit_order(data: OrderEdit, order_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.edit_order(db, order_id, data)


@router.post("/orders/{order_id}/complete")
def complete_order(order_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.complete_order(db, order_id)


@router.post("/orders/{order_id}/reactivate")
def reactivate_order(order_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.reactivate_order(db, order_id)
