from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from database import get_database
from routes.finance import finance_errors
from schemas.document_schema import DocumentCreate, DocumentList, DocumentResponse, DocumentAccountWrite
from schemas.finance_schema import FinanceDelete, parse_jalali
from security.auth import get_current_user
from services import document_service as service

router = APIRouter(prefix="/api/documents", tags=["Documents"], dependencies=[Depends(get_current_user)])
settings_router = APIRouter(prefix="/api/settings/document-accounts", tags=["Document accounts"], dependencies=[Depends(get_current_user)])


@settings_router.get("")
def list_accounts(db: Session = Depends(get_database)):
    with finance_errors():
        return service.account_list(db)


@settings_router.post("", status_code=201)
def add_account(data: DocumentAccountWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_account(db, data)


@settings_router.put("/{account_id}")
def edit_account(data: DocumentAccountWrite, account_id: int = Path(gt=0), db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_account(db, data, account_id)


@settings_router.delete("/{account_id}")
def delete_account(data: FinanceDelete, account_id: int = Path(gt=0), user=Depends(get_current_user), db: Session = Depends(get_database)):
    with finance_errors():
        return service.delete_account(db, account_id, data, user)


@router.get("", response_model=DocumentList)
def list_documents(
    search: str = Query("", max_length=200),
    start_date: str | None = Query(None, max_length=10),
    end_date: str | None = Query(None, max_length=10),
    document_type: str = Query("", max_length=100),
    skip: int = Query(0, ge=0),
    limit: int = Query(15, ge=1, le=15),
    db: Session = Depends(get_database),
):
    try:
        start_date = (parse_jalali(start_date) if "/" in start_date else date.fromisoformat(start_date)) if start_date else None
        end_date = (parse_jalali(end_date) if "/" in end_date else date.fromisoformat(end_date)) if end_date else None
    except ValueError:
        raise HTTPException(422, "تاریخ واردشده معتبر نیست.")
    if start_date and end_date and start_date > end_date:
        raise HTTPException(422, "تاریخ شروع نباید بعد از تاریخ پایان باشد.")
    with finance_errors():
        return service.list_documents(db, search, start_date, end_date, document_type, skip, limit)


@router.get("/next-number")
def next_number(db: Session = Depends(get_database)):
    with finance_errors():
        return service.preview_number(db)


@router.post("", response_model=DocumentResponse, status_code=201)
def register_document(data: DocumentCreate, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_document(db, data)


@router.get("/{document_id}", response_model=DocumentResponse)
def get_document(document_id: int = Path(gt=0), db: Session = Depends(get_database)):
    with finance_errors():
        return service.get_document(db, document_id)


@router.put("/{document_id}", response_model=DocumentResponse)
def edit_document(data: DocumentCreate, document_id: int = Path(gt=0), db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_document(db, data, document_id)


@router.delete("/{document_id}")
def remove_document(data: FinanceDelete, document_id: int = Path(gt=0), user=Depends(get_current_user), db: Session = Depends(get_database)):
    with finance_errors():
        return service.delete_document(db, document_id, data, user)
