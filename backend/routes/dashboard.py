from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from config import APP_TIMEZONE
from database import get_database
from routes.finance import finance_errors
from security.auth import get_current_user
from services.dashboard_service import dashboard

router = APIRouter(prefix="/api/dashboard", tags=["Dashboard"], dependencies=[Depends(get_current_user)])


@router.get("")
def report(response: Response, start_date: date | None = None, end_date: date | None = None,
           days: int = Query(30, ge=1, le=366),
           db: Session = Depends(get_database)):
    end = end_date or datetime.now(APP_TIMEZONE).date()
    if end.year < 1901:
        raise HTTPException(422, "تاریخ پایان باید پس از سال ۱۹۰۰ باشد.")
    start = start_date or end - timedelta(days=days - 1)
    if start > end or (end - start).days >= 366 or start.year < 1901:
        raise HTTPException(422, "بازه باید مرتب، حداکثر ۳۶۶ روز و پس از سال ۱۹۰۰ باشد.")
    response.headers["Cache-Control"] = "no-store"
    with finance_errors():
        return dashboard(db, start, end)
