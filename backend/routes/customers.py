import logging
from contextlib import contextmanager
from io import BytesIO
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from database import get_database, read_snapshot
from routes.finance import finance_errors
from schemas.customer_schema import CustomerList, CustomerResponse, CustomerWrite
from security.auth import get_current_user
from services import customer_import
from services import customer_service as service
from services.finance_service import customer_payment_history
from services.customer_ids import CustomerIDExhausted


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/customers", tags=["Customers"], dependencies=[Depends(get_current_user)])


@contextmanager
def customer_errors():
    try:
        yield
    except service.CustomerNotFound:
        raise HTTPException(404, "مشتری موردنظر پیدا نشد.")
    except service.SystemCustomerProtected:
        raise HTTPException(409, "حذف مشتری سیستمی یا تغییر نام و کد آن امکان‌پذیر نیست.")
    except customer_import.InvalidWorkbook as error:
        raise HTTPException(422, str(error))
    except CustomerIDExhausted:
        raise HTTPException(503, "تولید شناسه یکتای مشتری ممکن نشد؛ دوباره تلاش کنید.")
    except service.CustomerHasOrders:
        raise HTTPException(409, "مشتری دارای سفارش ثبت‌شده است و برای حفظ سوابق فاکتور قابل حذف نیست.")
    except service.CustomerHasPurchases:
        raise HTTPException(409, "این طرف حساب تأمین‌کنندهٔ خرید ثبت‌شده است و برای حفظ سوابق آن قابل حذف نیست.")
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
        read_snapshot(db)
        return service.list_customers(db, search, skip, limit)


@router.get("/options")
def customer_options(search: str = Query("", max_length=200), skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100), customer_id: int | None = Query(None, gt=0, le=9223372036854775807), include_address: bool = False, db: Session = Depends(get_database)):
    with customer_errors():
        return service.list_customers(db, search, skip, limit, options_only=True, customer_id=customer_id,
                                      include_address=include_address)


@router.get("/next-code")
def next_code(db: Session = Depends(get_database)):
    with customer_errors():
        # Preview only. POST assigns the authoritative code inside its lock.
        return {"customer_code": service.next_code(db)}


async def workbook_body(request: Request):
    content_type = request.headers.get("content-type", "").split(";", 1)[0]
    if content_type != customer_import.MIME_TYPE:
        raise HTTPException(415, "فایل با پسوند ‎.xlsx‎ انتخاب کنید.")
    with BytesIO() as source:
        async for chunk in request.stream():
            if source.tell() + len(chunk) > customer_import.MAX_BYTES:
                raise HTTPException(413, "حجم فایل اکسل نباید بیش از ۸ مگابایت باشد.")
            source.write(chunk)
        source.seek(0)
        yield source


@router.get("/import/template")
def customer_import_template():
    return Response(customer_import.template(), media_type=customer_import.MIME_TYPE, headers={
        "Content-Disposition": 'attachment; filename="customers-template.xlsx"',
    })


@router.post("/import/inspect")
def inspect_customer_workbook(source=Depends(workbook_body)):
    with customer_errors():
        return customer_import.inspect_workbook(source)


@router.post("/import/{action}")
def process_customer_workbook(
    action: Literal["preview", "commit"],
    columns: Annotated[list[str], Query(min_length=1, max_length=customer_import.MAX_COLUMNS)],
    sheet: int = Query(ge=0, lt=customer_import.MAX_SHEETS),
    source=Depends(workbook_body),
    db: Session = Depends(get_database),
):
    with customer_errors():
        rows = customer_import.read_rows(source, sheet, columns)
        return customer_import.import_rows(db, rows, commit=action == "commit")


@router.get("/{customer_id}", response_model=CustomerResponse)
def get_customer(customer_id: int, db: Session = Depends(get_database)):
    with customer_errors():
        read_snapshot(db)
        return service.serialize_customer(service.get_customer(db, customer_id))


@router.get("/{customer_id}/payments")
def payments(customer_id: int = Path(gt=0, le=2**63 - 1), cursor: str | None = Query(None, min_length=1, max_length=512),
             db: Session = Depends(get_database)):
    with customer_errors(), finance_errors():
        read_snapshot(db)
        service.get_customer(db, customer_id)
        return customer_payment_history(db, customer_id, cursor)


@router.get("/{customer_id}/invoices")
def invoices(customer_id: int = Path(gt=0, le=2**63 - 1), skip: int = Query(0, ge=0, le=2**63 - 1),
             limit: int = Query(15, ge=1, le=50), db: Session = Depends(get_database)):
    with customer_errors():
        read_snapshot(db)
        service.get_customer(db, customer_id)
        return service.invoice_history(db, customer_id, skip, limit)


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
