from datetime import date

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    status,
)

from sqlalchemy.exc import (
    SQLAlchemyError,
)

from sqlalchemy.orm import Session

from database import (
    get_database,
)

from models.user import User

from schemas.attendance_schema import (
    AttendanceCalendarDayResponse,
    AttendanceCreate,
    AttendanceDayDetailsResponse,
    AttendanceMemberSummary,
    AttendanceRecordResponse,
    AttendanceUpdate,
)

from security.auth import (
    get_current_user,
)

from services.attendance_service import (
    AttendanceNotFoundError,
    InvalidAttendanceStatusError,
    MemberNotFoundError,
    get_attendance_day_details,
    get_attendance_history,
    get_calendar_statistics,
    get_member_attendance_summaries,
    record_today_attendance,
    update_attendance_record,
)


router = APIRouter(
    prefix="/api/attendance",
    tags=["Attendance"],
)


MAX_CALENDAR_RANGE_DAYS = 62


# ======================================================
# Error Helpers
# ======================================================


def member_not_found():
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="عضو موردنظر پیدا نشد",
    )


def attendance_not_found():
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="رکورد حضور و غیاب پیدا نشد",
    )


def invalid_attendance_status():
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail="وضعیت حضور و غیاب معتبر نیست",
    )


def database_error():
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="خطایی در پردازش اطلاعات رخ داد",
    )


# ======================================================
# History
# ======================================================


@router.get(
    "",
    response_model=list[
        AttendanceRecordResponse
    ],
)
def attendance_history(
    member_id: int | None = Query(
        default=None,
        gt=0,
    ),
    skip: int = Query(
        default=0,
        ge=0,
    ),
    limit: int = Query(
        default=100,
        ge=1,
        le=500,
    ),
    db: Session = Depends(
        get_database
    ),
    current_user: User = Depends(
        get_current_user
    ),
):
    try:
        return get_attendance_history(
            db,
            member_id=member_id,
            skip=skip,
            limit=limit,
        )

    except SQLAlchemyError:
        raise database_error()


# ======================================================
# Today
# ======================================================


@router.get(
    "/today",
    response_model=list[
        AttendanceMemberSummary
    ],
)
def today_attendance(
    db: Session = Depends(
        get_database
    ),
    current_user: User = Depends(
        get_current_user
    ),
):
    """
    اطلاعات موردنیاز کارت‌های صفحه Attendance.

    شامل:
    - اطلاعات عضو
    - وضعیت امروز
    - ساعت ثبت
    - کل حضور
    - کل غیبت
    - حضور ماه جاری شمسی
    - غیبت ماه جاری شمسی
    """

    try:
        return (
            get_member_attendance_summaries(
                db
            )
        )

    except SQLAlchemyError:
        raise database_error()


# ======================================================
# Day Details
# ======================================================


@router.get(
    "/date/{target_date}",
    response_model=(
        AttendanceDayDetailsResponse
    ),
)
def attendance_by_date(
    target_date: date,
    db: Session = Depends(
        get_database
    ),
    current_user: User = Depends(
        get_current_user
    ),
):
    try:
        return (
            get_attendance_day_details(
                db,
                target_date,
            )
        )

    except SQLAlchemyError:
        raise database_error()


# ======================================================
# Calendar
# ======================================================


@router.get(
    "/calendar",
    response_model=list[
        AttendanceCalendarDayResponse
    ],
)
def attendance_calendar(
    start_date: date = Query(),
    end_date: date = Query(),
    db: Session = Depends(
        get_database
    ),
    current_user: User = Depends(
        get_current_user
    ),
):
    if end_date < start_date:
        raise HTTPException(
            status_code=(
                status.HTTP_400_BAD_REQUEST
            ),
            detail=(
                "تاریخ پایان نمی‌تواند "
                "قبل از تاریخ شروع باشد"
            ),
        )


    range_days = (
        end_date - start_date
    ).days


    if (
        range_days >
        MAX_CALENDAR_RANGE_DAYS
    ):
        raise HTTPException(
            status_code=(
                status.HTTP_400_BAD_REQUEST
            ),
            detail=(
                "بازه تقویم بیش از حد مجاز است"
            ),
        )


    try:
        return get_calendar_statistics(
            db,
            start_date,
            end_date,
        )

    except ValueError:
        raise HTTPException(
            status_code=(
                status.HTTP_400_BAD_REQUEST
            ),
            detail="بازه تاریخ معتبر نیست",
        )

    except SQLAlchemyError:
        raise database_error()


# ======================================================
# Record Today Attendance
# ======================================================


@router.post(
    "",
    response_model=(
        AttendanceRecordResponse
    ),
)
def record_attendance(
    data: AttendanceCreate,
    db: Session = Depends(
        get_database
    ),
    current_user: User = Depends(
        get_current_user
    ),
):
    """
    اگر رکورد امروز وجود نداشته باشد:
        Create

    اگر وجود داشته باشد:
        Update همان رکورد

    Frontend تاریخ یا ساعت ارسال نمی‌کند.
    """

    try:
        return record_today_attendance(
            db,
            member_id=data.member_id,
            status=data.status,
        )

    except MemberNotFoundError:
        raise member_not_found()

    except InvalidAttendanceStatusError:
        raise invalid_attendance_status()

    except SQLAlchemyError:
        raise database_error()


# ======================================================
# Update Attendance Record
# ======================================================


@router.put(
    "/{attendance_id}",
    response_model=(
        AttendanceRecordResponse
    ),
)
def update_attendance(
    attendance_id: int,
    data: AttendanceUpdate,
    db: Session = Depends(
        get_database
    ),
    current_user: User = Depends(
        get_current_user
    ),
):
    if attendance_id <= 0:
        raise HTTPException(
            status_code=(
                status.HTTP_422_UNPROCESSABLE_ENTITY
            ),
            detail="شناسه رکورد معتبر نیست",
        )


    try:
        return update_attendance_record(
            db,
            attendance_id,
            data.status,
        )

    except AttendanceNotFoundError:
        raise attendance_not_found()

    except InvalidAttendanceStatusError:
        raise invalid_attendance_status()

    except SQLAlchemyError:
        raise database_error()