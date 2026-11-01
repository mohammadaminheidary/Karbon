"""Persist completed exports; history downloads never regenerate business data."""
from datetime import timezone

from fastapi import HTTPException
from sqlalchemy import func, select, text

from models.generated_report import GeneratedReport
from services import report_service


def save(db, user_id, name, request, fmt, path, record_count, column_count):
    content = path.read_bytes()
    report = GeneratedReport(
        user_id=user_id, name=request.report_name.strip() or f"گزارش {report_service.TABLES[name]}",
        dataset=name, format=fmt, record_count=record_count, column_count=column_count,
        size_bytes=len(content), parameters=request.model_dump(mode="json"), content=content,
    )
    try:
        # Export has finished its read snapshot. Reserve SQLite's writer before
        # choosing an ID so simultaneous workers cannot claim the same gap.
        db.rollback()
        db.execute(text("BEGIN IMMEDIATE"))
        report.id = db.scalar(text("""
            SELECT MIN(candidate)
            FROM (
                SELECT 1 AS candidate
                UNION ALL
                SELECT id + 1 FROM generated_reports
            ) AS candidates
            WHERE NOT EXISTS (
                SELECT 1 FROM generated_reports WHERE id = candidates.candidate
            )
        """))
        db.add(report)
        db.commit()
    except BaseException:
        db.rollback()
        raise


def listing(db, user_id, offset, limit):
    scope = GeneratedReport.user_id == user_id
    total = db.scalar(select(func.count()).select_from(GeneratedReport).where(scope))
    reports = db.scalars(select(GeneratedReport).where(scope).order_by(
        GeneratedReport.created_at.desc(), GeneratedReport.id.desc()).offset(offset).limit(limit))
    return {"total": total, "items": [metadata(r) for r in reports]}


def metadata(r):
    return dict(
        id=r.id, name=r.name, dataset=r.dataset, dataset_title=report_service.TABLES.get(r.dataset, r.dataset),
        format=r.format, created_at=r.created_at.replace(tzinfo=timezone.utc).isoformat(),
        record_count=r.record_count, column_count=r.column_count, size_bytes=r.size_bytes,
    )


def remove(db, user_id, report_id):
    try:
        # Deletion and allocation share the same database-level write lock.
        # A deleted ID becomes available only when this transaction commits.
        db.rollback()
        db.execute(text("BEGIN IMMEDIATE"))
        report = get(db, user_id, report_id)
        db.delete(report)
        db.commit()
    except BaseException:
        db.rollback()
        raise


def get(db, user_id, report_id):
    report = db.scalar(select(GeneratedReport).where(
        GeneratedReport.id == report_id, GeneratedReport.user_id == user_id))
    if report is None:
        raise HTTPException(404, "گزارش پیدا نشد.")
    return report


def media_type(fmt):
    return "application/pdf" if fmt == "pdf" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
