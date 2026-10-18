from collections import defaultdict, deque
import threading
import time

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from database import get_database
from models.member import Member
from models.member_face import MemberFace
from security.auth import get_current_user
from schemas.attendance_schema import AttendanceRecordResponse
from schemas.face_schema import FaceRegistration, FaceSamples, FaceValidation, FaceGuide
from services.attendance_service import check_in_member
from services.face_service import FaceError, engine, recognize_member, register_face, validate_registration, registration_feedback

router = APIRouter(prefix="/api/faces", tags=["Faces"], dependencies=[Depends(get_current_user)])
attempts = defaultdict(deque)
attempts_lock = threading.Lock()


def limit_attempts(user_id, lane, limit):
    now = time.monotonic()
    with attempts_lock:
        # Prune inactive sessions so the limiter has bounded memory.
        for key in list(attempts):
            if not attempts[key] or now - attempts[key][-1] >= 60:
                del attempts[key]
        recent = attempts[(user_id, lane)]
        while recent and now - recent[0] >= 60:
            recent.popleft()
        if len(recent) >= limit:
            retry = max(1, int(60 - (now - recent[0])) + 1)
            raise HTTPException(429, detail={"code": "RATE_LIMIT", "message": "کمی صبر کنید و دوباره تلاش کنید."}, headers={"Retry-After": str(retry)})
        recent.append(now)


def rate_limit(user=Depends(get_current_user)):
    limit_attempts(user.id, "capture", 30)


def guide_rate_limit(user=Depends(get_current_user)):
    limit_attempts(user.id, "guide", 180)


def face_error(error):
    detail = {"code": error.code, "message": error.message}
    if error.sample_index is not None:
        detail["sample_index"] = error.sample_index
    return HTTPException(error.status, detail=detail)


def storage_error():
    return HTTPException(503, detail={"code": "UNAVAILABLE", "message": "پردازش چهره انجام نشد. از ورود دستی استفاده کنید."})


@router.get("/status")
def status():
    try:
        with engine.session():
            pass
        return {"available": True}
    except FaceError as error:
        return {"available": False, "code": error.code, "message": error.message}
    except Exception:
        return {"available": False, "message": "تشخیص چهره آماده نیست. از ورود دستی استفاده کنید."}


@router.get("/members")
def enrolled_members(db: Session = Depends(get_database)):
    # Templates and matching scores never leave the backend.
    return [{"member_id": row.member_id, "updated_at": row.updated_at} for row in db.query(MemberFace).all()]


@router.put("/members/{member_id}", dependencies=[Depends(rate_limit)])
def enroll(member_id: int, data: FaceRegistration, db: Session = Depends(get_database)):
    if db.get(Member, member_id) is None:
        raise HTTPException(404, "عضو موردنظر پیدا نشد")
    try:
        register_face(db, member_id, data.images)
        return {"member_id": member_id, "registered": True}
    except FaceError as error:
        db.rollback()
        raise face_error(error)
    except Exception:
        db.rollback()
        # Deliberately do not log frame payloads or return exception internals.
        raise storage_error()


@router.post("/validate", dependencies=[Depends(rate_limit)])
def validate(data: FaceValidation):
    try:
        validate_registration(data.images)
        return {"valid": True, "accepted": len(data.images)}
    except FaceError as error:
        raise face_error(error)
    except Exception:
        raise storage_error()


@router.post("/guide", dependencies=[Depends(guide_rate_limit)])
def guide(data: FaceGuide):
    try:
        return registration_feedback(data.image, data.angle, data.reference)
    except FaceError as error:
        raise face_error(error)
    except Exception:
        raise storage_error()


@router.delete("/members/{member_id}", status_code=204)
def remove(member_id: int, db: Session = Depends(get_database)):
    if db.get(Member, member_id) is None:
        raise HTTPException(404, "عضو موردنظر پیدا نشد")
    try:
        db.query(MemberFace).filter(MemberFace.member_id == member_id).delete()
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        raise storage_error()
    return Response(status_code=204)


@router.post("/check-in", dependencies=[Depends(rate_limit)])
def recognize(data: FaceSamples, db: Session = Depends(get_database)):
    try:
        member_id = recognize_member(db, data.images)
        member = db.get(Member, member_id)
        if member is None:
            raise HTTPException(404, "عضو موردنظر پیدا نشد")
        record, already_checked_in = check_in_member(db, member_id)
        return {
            "member": {"id": member.id, "first_name": member.first_name, "last_name": member.last_name},
            "attendance": AttendanceRecordResponse.model_validate(record).model_dump(mode="json"),
            "already_checked_in": already_checked_in,
        }
    except FaceError as error:
        db.rollback()
        raise face_error(error)
    except HTTPException:
        raise
    except Exception:
        db.rollback()
        raise storage_error()
