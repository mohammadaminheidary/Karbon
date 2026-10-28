from typing import Literal
from fastapi import APIRouter, Depends, Path
from sqlalchemy.orm import Session
from database import get_database
from security.auth import get_current_user
from routes.finance import finance_errors
from schemas.inventory_schema import InventoryOptionWrite
from services import inventory_service as service

router = APIRouter(prefix="/api/settings/inventory-options", tags=["Inventory settings"], dependencies=[Depends(get_current_user)])
OptionKind = Literal["categories", "units"]


@router.get("")
def options(db: Session = Depends(get_database)):
    return service.list_options(db)


@router.post("/{kind}", status_code=201)
def add_option(kind: OptionKind, data: InventoryOptionWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_option(db, kind, data)


@router.put("/{kind}/{option_id}")
def edit_option(kind: OptionKind, data: InventoryOptionWrite, option_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_option(db, kind, data, option_id)
