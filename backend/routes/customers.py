import logging
from contextlib import contextmanager

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from database import get_database
from schemas.customer_schema import CustomerList, CustomerResponse, CustomerWrite
from security.auth import get_current_user
from services import customer_service as service


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/customers", tags=["Customers"], dependencies=[Depends(get_current_user)])


@contextmanager
def customer_errors():
    try:
        yield
    except service.CustomerNotFound:
        raise HTTPException(404, "مشتری موردنظر پیدا نشد.")
    except service.CustomerHasTransactions as error:
        raise HTTPException(409, f"این مشتری {error.count} تراکنش حذف‌نشده دارد. ابتدا تراکنش‌های او را در بخش مالی حذف کنید، سپس مشتری را حذف کنید.")
    except service.DuplicateCustomers as error:
        raise HTTPException(409, detail={
            "code": "DUPLICATE_CUSTOMER",
            "message": "مشتری مشابه پیدا شد؛ برای ادامه ثبت، تأیید کنید.",
            "matches": error.matches,
        })
    except IntegrityError:
        logger.exception("Customer integrity constraint failed")
        raise HTTPException(409, "حذف یا ذخیره مشتری به علت اطلاعات مرتبط امکان‌پذیر نیست.")
    except SQLAlchemyError:
        logger.exception("Customer database operation failed")
        raise HTTPException(500, "خطایی در دریافت یا ذخیره اطلاعات مشتریان رخ داد.")


@router.get("", response_model=CustomerList)
def list_customers(search: str = Query("", max_length=200), skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100), db: Session = Depends(get_database)):
    with customer_errors():
        return service.list_customers(db, search, skip, limit)


@router.get("/next-code")
def next_code(db: Session = Depends(get_database)):
    with customer_errors():
        # Preview only. POST assigns the authoritative code inside its lock.
        return {"customer_code": service.next_code(db)}


@router.get("/{customer_id}", response_model=CustomerResponse)
def get_customer(customer_id: int, db: Session = Depends(get_database)):
    with customer_errors():
        return service.serialize_customer(service.get_customer(db, customer_id))


@router.post("", response_model=CustomerResponse, status_code=201)
def create_customer(data: CustomerWrite, db: Session = Depends(get_database)):
    with customer_errors():
        return service.save_customer(db, data)


@router.put("/{customer_id}", response_model=CustomerResponse)
def update_customer(customer_id: int, data: CustomerWrite, db: Session = Depends(get_database)):
    with customer_errors():
        return service.save_customer(db, data, customer_id)


@router.delete("/{customer_id}", status_code=204)
def delete_customer(customer_id: int, db: Session = Depends(get_database)):
    with customer_errors():
        service.delete_customer(db, customer_id)
    return Response(status_code=204)
