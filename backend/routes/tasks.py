from fastapi import APIRouter, Depends, HTTPException, Path, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from database import get_database
from schemas.task_schema import TaskCreate, TaskResponse, TaskStatusUpdate
from security.auth import get_current_user
from services.task_service import create_task, get_tasks, update_task_status, update_task, delete_task


router = APIRouter(
    prefix="/api/tasks", tags=["Tasks"], dependencies=[Depends(get_current_user)]
)


def database_error(db):
    db.rollback()
    return HTTPException(status_code=500, detail="خطایی در ذخیره یا دریافت کارها رخ داد.")


@router.get("", response_model=list[TaskResponse])
def list_tasks(db: Session = Depends(get_database)):
    try:
        return get_tasks(db)
    except SQLAlchemyError:
        raise database_error(db)


@router.post("", response_model=TaskResponse, status_code=201)
def add_task(data: TaskCreate, db: Session = Depends(get_database)):
    try:
        return create_task(db, data)
    except SQLAlchemyError:
        raise database_error(db)


@router.put("/{task_id}/status", response_model=TaskResponse)
def change_task_status(
    data: TaskStatusUpdate,
    task_id: int = Path(gt=0),
    db: Session = Depends(get_database),
):
    try:
        task = update_task_status(db, task_id, data.status)
    except SQLAlchemyError:
        raise database_error(db)
    if task is None:
        raise HTTPException(status_code=404, detail="کار موردنظر پیدا نشد.")
    return task


@router.put("/{task_id}", response_model=TaskResponse)
def edit_task(
    data: TaskCreate,
    task_id: int = Path(gt=0),
    db: Session = Depends(get_database),
):
    try:
        task = update_task(db, task_id, data)
    except SQLAlchemyError:
        raise database_error(db)
    if task is None:
        raise HTTPException(status_code=404, detail="کار موردنظر پیدا نشد.")
    return task


@router.delete("/{task_id}", status_code=204)
def remove_task(task_id: int = Path(gt=0), db: Session = Depends(get_database)):
    try:
        deleted = delete_task(db, task_id)
    except SQLAlchemyError:
        raise database_error(db)
    if not deleted:
        raise HTTPException(status_code=404, detail="کار موردنظر پیدا نشد.")
    return Response(status_code=204)
