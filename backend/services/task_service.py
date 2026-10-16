from models.task import Task


def get_tasks(db):
    return db.query(Task).order_by(Task.date.asc(), Task.id.desc()).all()


def create_task(db, data):
    task = Task(**data.model_dump())
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def update_task_status(db, task_id, status):
    task = db.get(Task, task_id)
    if task is None:
        return None
    task.status = status
    db.commit()
    db.refresh(task)
    return task


def update_task(db, task_id, data):
    task = db.get(Task, task_id)
    if task is None:
        return None
    for field, value in data.model_dump().items():
        setattr(task, field, value)
    db.commit()
    db.refresh(task)
    return task


def delete_task(db, task_id):
    task = db.get(Task, task_id)
    if task is None:
        return False
    db.delete(task)
    db.commit()
    return True
