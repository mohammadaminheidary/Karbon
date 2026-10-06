import logging
from contextlib import contextmanager
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Path
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from database import get_database
from models.finance import BankAccount, ExpenseCategory, FinancialTransaction
from schemas.finance_schema import BankWrite, CategoryWrite, TransactionWrite, TransactionEdit, FinanceDelete
from security.auth import get_current_user
from services import finance_service as service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["Finance"], dependencies=[Depends(get_current_user)])


@contextmanager
def finance_errors():
    try:
        yield
    except service.FinanceError as error:
        raise HTTPException(error.status, error.message)
    except IntegrityError:
        logger.exception("Finance constraint failed")
        raise HTTPException(409, "شماره کارت، شبا، شماره حساب یا عنوان تکراری است، یا اطلاعات مرتبط قابل ذخیره نیست.")
    except SQLAlchemyError:
        logger.exception("Finance database operation failed")
        raise HTTPException(500, "خطایی در دریافت یا ذخیره اطلاعات مالی رخ داد.")


@router.get("/banks/catalog")
def bank_catalog(db: Session = Depends(get_database)):
    with finance_errors():
        return service.bank_catalog(db)


@router.get("/banks")
def banks(db: Session = Depends(get_database)):
    with finance_errors():
        return service.bank_list(db)


@router.post("/banks", status_code=201)
def create_bank(data: BankWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_reference(db, BankAccount, data)


@router.put("/banks/{bank_id}")
def update_bank(bank_id: int, data: BankWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_reference(db, BankAccount, data, bank_id)


@router.get("/banks/{bank_id}/activity")
def bank_activity(bank_id: int = Path(gt=0, le=9223372036854775807), period: Literal["day", "yesterday", "week", "month", "quarter", "year"] = "month",
                  anchor: str | None = None, db: Session = Depends(get_database)):
    with finance_errors():
        return service.bank_activity(db, bank_id, period, anchor)


@router.get("/banks/{bank_id}/transactions")
def bank_transactions(bank_id: int = Path(gt=0, le=9223372036854775807), start_date: str | None = None, end_date: str | None = None,
                      day: str | None = None, month: str | None = None, year: str | None = None,
                      min_amount: int | None = Query(default=None, ge=0, le=999999999999),
                      max_amount: int | None = Query(default=None, ge=0, le=999999999999),
                      search: str | None = Query(default=None, max_length=200),
                      cursor: str | None = Query(default=None, max_length=512), db: Session = Depends(get_database)):
    with finance_errors():
        return service.bank_transactions(db, bank_id, start_date=start_date, end_date=end_date, day=day, month=month,
                                         year=year, min_amount=min_amount, max_amount=max_amount, search=search, cursor=cursor)


@router.get("/settings/expense-categories")
def categories(db: Session = Depends(get_database)):
    with finance_errors():
        return service.category_list(db)


@router.post("/settings/expense-categories", status_code=201)
def create_category(data: CategoryWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_reference(db, ExpenseCategory, data)


@router.put("/settings/expense-categories/{category_id}")
def update_category(category_id: int, data: CategoryWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_reference(db, ExpenseCategory, data, category_id)


@router.get("/finance/calendar")
def calendar(start_date: date, end_date: date, db: Session = Depends(get_database)):
    with finance_errors():
        return service.calendar(db, start_date, end_date)


@router.get("/finance/day")
def daily(date: date, db: Session = Depends(get_database)):
    with finance_errors():
        return service.daily(db, date)


@router.post("/finance/transactions", status_code=201)
def create_transaction(data: TransactionWrite, db: Session = Depends(get_database)):
    with finance_errors():
        return service.save_transaction(db, data)


@router.put("/finance/transactions/{transaction_id}")
def edit_transaction(data: TransactionEdit, transaction_id: int = Path(gt=0, le=9223372036854775807), db: Session = Depends(get_database)):
    with finance_errors():
        return service.edit_transaction(db, transaction_id, data)


@router.delete("/finance/transactions/{transaction_id}")
def delete_transaction(data: FinanceDelete, transaction_id: int = Path(gt=0, le=9223372036854775807),
                       user=Depends(get_current_user), db: Session = Depends(get_database)):
    with finance_errors():
        return service.delete_finance_record(db, FinancialTransaction, transaction_id, data, user)


@router.delete("/banks/{bank_id}")
def delete_bank(data: FinanceDelete, bank_id: int = Path(gt=0, le=9223372036854775807),
                user=Depends(get_current_user), db: Session = Depends(get_database)):
    with finance_errors():
        return service.delete_finance_record(db, BankAccount, bank_id, data, user)


@router.delete("/settings/expense-categories/{category_id}")
def delete_category(data: FinanceDelete, category_id: int = Path(gt=0, le=9223372036854775807),
                    user=Depends(get_current_user), db: Session = Depends(get_database)):
    with finance_errors():
        return service.delete_finance_record(db, ExpenseCategory, category_id, data, user)
