"""Authenticated reporting and immutable export history; business data is read-only."""
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
from services import report_history

router = APIRouter(prefix="/api/reports", tags=["Reports"], dependencies=[Depends(get_current_user)])


@router.get("")
def catalog(response: Response, db: Session = Depends(get_database)):
    response.headers["Cache-Control"] = "no-store"
    return [dict(name=n, title=service.TABLES[n]) for n in service.catalog(db.get_bind())]


@router.get("/{name}/schema")
def schema(name: str, response: Response, db: Session = Depends(get_database)):
    response.headers["Cache-Control"] = "no-store"
    return service.schema(db, name)


@router.get("/history")
def history(response: Response, offset: int = Query(default=0, ge=0),
            limit: int = Query(default=50, ge=1, le=200),
            db: Session = Depends(get_database), user=Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    return report_history.listing(db, user.id, offset, limit)


@router.get("/history/{report_id}/download")
def saved_download(report_id: int, db: Session = Depends(get_database), user=Depends(get_current_user)):
    report = report_history.get(db, user.id, report_id)
    return Response(content=report.content, media_type=report_history.media_type(report.format), headers={
        "Cache-Control": "no-store",
        "Content-Disposition": f'attachment; filename="karbon-{report.dataset}-{report.id}.{report.format}"',
    })


@router.get("/history/{report_id}")
def details(report_id: int, response: Response, db: Session = Depends(get_database), user=Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    return report_history.metadata(report_history.get(db, user.id, report_id))


@router.delete("/history/{report_id}", status_code=204)
def delete_report(report_id: int, db: Session = Depends(get_database), user=Depends(get_current_user)):
    report_history.remove(db, user.id, report_id)
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


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
def download(name: str, fmt: Literal["pdf", "xlsx"], request: ReportRequest,
             db: Session = Depends(get_database), user=Depends(get_current_user)):
    # Capture identity/column metadata before export releases its read snapshot.
    user_id = user.id
    column_count = len(service.selected(service.dataset(db, name), request))
    handle = tempfile.NamedTemporaryFile(prefix="karbon-report-", suffix=f".{fmt}", delete=False)
    path = Path(handle.name)
    handle.close()
    try:
        count = export(db, name, request, fmt, path)
        report_history.save(db, user_id, name, request, fmt, path, count, column_count)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    media = report_history.media_type(fmt)
    return FileResponse(path, media_type=media, filename=f"karbon-{name}.{fmt}",
                        headers={"Cache-Control": "no-store"},
                        background=BackgroundTask(path.unlink, missing_ok=True))
