"""Authenticated, read-only report API. Export POSTs never mutate business data."""
from pathlib import Path
import tempfile
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from sqlalchemy.orm import Session

from database import get_database
from security.auth import get_current_user
from schemas.report_schema import ReportRequest
from services import report_service as service
from services.report_export import export

router = APIRouter(prefix="/api/reports", tags=["Reports"], dependencies=[Depends(get_current_user)])


@router.get("")
def catalog(response: Response, db: Session = Depends(get_database)):
    response.headers["Cache-Control"] = "no-store"
    return [dict(name=n, title=service.TABLES[n]) for n in service.catalog(db.get_bind())]


@router.get("/{name}/schema")
def schema(name: str, response: Response, db: Session = Depends(get_database)):
    response.headers["Cache-Control"] = "no-store"
    return service.schema(db, name)


@router.get("/{name}/options")
def options(name: str, field: str, response: Response, search: str = Query(default="", max_length=200),
            offset: int = Query(default=0, ge=0), db: Session = Depends(get_database)):
    response.headers["Cache-Control"] = "no-store"
    return service.options(db, name, field, search, offset)


@router.post("/{name}/preview")
def preview(name: str, request: ReportRequest, response: Response, db: Session = Depends(get_database)):
    response.headers["Cache-Control"] = "no-store"
    return service.preview(db, name, request)


@router.post("/{name}/export/{fmt}")
def download(name: str, fmt: Literal["pdf", "xlsx"], request: ReportRequest, db: Session = Depends(get_database)):
    handle = tempfile.NamedTemporaryFile(prefix="karbon-report-", suffix=f".{fmt}", delete=False)
    path = Path(handle.name)
    handle.close()
    try:
        export(db, name, request, fmt, path)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    media = "application/pdf" if fmt == "pdf" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return FileResponse(path, media_type=media, filename=f"karbon-{name}.{fmt}",
                        headers={"Cache-Control": "no-store"},
                        background=BackgroundTask(path.unlink, missing_ok=True))
