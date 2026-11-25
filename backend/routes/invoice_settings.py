from typing import Annotated
from fastapi import APIRouter, Depends, Path, Query, Response
from sqlalchemy.orm import Session

from database import get_database
from routes.finance import finance_errors
from schemas.invoice_settings_schema import AssetUpload, InvoiceKind, SettingsWrite, TemplateCreate, TemplateWrite
from security.auth import ADMIN_USERNAME, get_current_user, require_admin
from services import invoice_settings_service as service

router = APIRouter(prefix="/api/settings/invoice-design", tags=["Invoice settings"],
                   dependencies=[Depends(get_current_user)])
admin = [Depends(require_admin)]
TemplateID = Annotated[int, Path(gt=0, le=2**63 - 1)]


@router.get("")
def settings(db: Session = Depends(get_database), user=Depends(get_current_user)):
    return service.settings_data(db, user.username == ADMIN_USERNAME)


@router.put("", dependencies=admin)
def update(data: SettingsWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.update_settings(db, data)


@router.post("/assets", status_code=201, dependencies=admin)
def upload(data: AssetUpload, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_asset(db, data.data)


@router.get("/preview-assets")
def assets(db: Session = Depends(get_database)):
    data = service.preferences(db).data
    return service.asset_urls(db, data["store"], data["signatures"])


@router.get("/templates/standard/{kind}")
def standard(kind: InvoiceKind):
    return service.default_layout(kind)


@router.get("/templates/{key}")
def template(key: TemplateID, db: Session = Depends(get_database)):
    with finance_errors():
        return service.read_template(db, key)


@router.post("/templates", status_code=201, dependencies=admin)
def create(data: TemplateCreate, db: Session = Depends(get_database)):
    with finance_errors():
        return service.create_template(db, data)


@router.put("/templates/{key}", dependencies=admin)
def edit(key: TemplateID, data: TemplateWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.update_template(db, key, data)


@router.put("/templates/{key}/default", status_code=204, dependencies=admin)
def set_default(key: TemplateID, db: Session = Depends(get_database)):
    with finance_errors():
        service.set_default(db, key)
    return Response(status_code=204)


@router.delete("/templates/{key}", status_code=204, dependencies=admin)
def delete(key: TemplateID, revision: Annotated[int, Query(ge=1)], db: Session = Depends(get_database)):
    with finance_errors():
        service.delete_template(db, key, revision)
    return Response(status_code=204)
