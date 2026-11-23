from typing import Literal
from fastapi import APIRouter, Depends, Path
from sqlalchemy.orm import Session
from database import get_database
from security.auth import get_current_user
from routes.finance import finance_errors
from schemas.inventory_schema import InventoryCategoryWrite, InventoryNameWrite, PurchaseWrite
from services import inventory_service as service

router = APIRouter(prefix="/api/settings/inventory-options", tags=["Inventory settings"], dependencies=[Depends(get_current_user)])
OptionKind = Literal["categories", "units"]
purchase_router = APIRouter(prefix="/api/purchases", tags=["Purchases"], dependencies=[Depends(get_current_user)])
brand_router = APIRouter(prefix="/api/settings/brands", tags=["Inventory settings"], dependencies=[Depends(get_current_user)])


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


@purchase_router.get("/next-number")
def next_purchase(db: Session = Depends(get_database)):
    return {"invoice_number": service.next_purchase_number(db)}


@purchase_router.post("", status_code=201)
def create_purchase(data: PurchaseWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_purchase(db, data)


@purchase_router.get("/{purchase_id}")
def purchase(purchase_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.get_purchase(db, purchase_id)


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


@router.delete("/categories/{option_id}")
def delete_category(option_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.delete_category(db, option_id)
