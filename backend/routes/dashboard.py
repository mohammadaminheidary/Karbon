from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from database import get_database
from routes.finance import finance_errors
from security.auth import get_current_user
from services.dashboard_service import dashboard
from services.fiscal_period import active_period, effective_day

router = APIRouter(prefix="/api/dashboard", tags=["Dashboard"], dependencies=[Depends(get_current_user)])


@router.get("")
def report(response: Response, start_date: date | None = None, end_date: date | None = None,
           days: int = Query(30, ge=1, le=366),
           view: Literal["full", "summary", "debtors", "products"] = "full",
           include_debtors: bool = False, include_products: bool = False,
           db: Session = Depends(get_database)):
    period = active_period(db)
    end = end_date or effective_day(period)
    if end.year < 1901:
        raise HTTPException(422, "تاریخ پایان باید پس از سال ۱۹۰۰ باشد.")
    start = start_date or end - timedelta(days=days - 1)
    if period and not start_date and not end_date:
        start = max(start, period.start_date)
    if start > end or (end - start).days >= 366 or start.year < 1901:
        raise HTTPException(422, "بازه باید مرتب، حداکثر ۳۶۶ روز و پس از سال ۱۹۰۰ باشد.")
    response.headers["Cache-Control"] = "no-store"
    with finance_errors():
        return dashboard(db, start, end, view, include_debtors, include_products)
