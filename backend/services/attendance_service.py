from datetime import (
    date,
    datetime,
    timedelta,
)

import jdatetime

from sqlalchemy import (
    and_,
    case,
    func,
)

from sqlalchemy.exc import (
    IntegrityError,
    SQLAlchemyError,
)

from sqlalchemy.orm import Session

from config import (
    APP_TIMEZONE,
)

from models.attendance import (
    Attendance,
)

from models.member import (
    Member,
)


VALID_ATTENDANCE_STATUSES = {
    "present",
    "absent",
}


   #Service Errors


class AttendanceServiceError(
    Exception
):
    pass


class MemberNotFoundError(
    AttendanceServiceError
):
    pass


class AttendanceNotFoundError(
    AttendanceServiceError
):
    pass


class InvalidAttendanceStatusError(
    AttendanceServiceError
):
    pass



   #Time



def get_local_now():
    return datetime.now(
        APP_TIMEZONE
    )


def get_local_today():
    return get_local_now().date()


def get_recorded_time(
    current_datetime=None,
):
    current_datetime = (
        current_datetime
        or get_local_now()
    )


    return (
        current_datetime
        .time()
        .replace(
            microsecond=0
        )
    )

   #Persian Month


def get_current_persian_month_range(
    reference_date=None,
):
    """
    خروجی:
        start_date
        end_date

    هر دو تاریخ Gregorian هستند.

    end_date به‌صورت exclusive است:

        start_date <= date < end_date
    """

    reference_date = (
        reference_date
        or get_local_today()
    )


    jalali_date = (
        jdatetime.date
        .fromgregorian(
            date=reference_date
        )
    )


    month_start_jalali = (
        jdatetime.date(
            jalali_date.year,
            jalali_date.month,
            1,
        )
    )


    if jalali_date.month == 12:
        next_month_jalali = (
            jdatetime.date(
                jalali_date.year + 1,
                1,
                1,
            )
        )

    else:
        next_month_jalali = (
            jdatetime.date(
                jalali_date.year,
                jalali_date.month + 1,
                1,
            )
        )


    start_date = (
        month_start_jalali
        .togregorian()
    )


    end_date = (
        next_month_jalali
        .togregorian()
    )


    return (
        start_date,
        end_date,
    )


   #Validation


def validate_status(
    status,
):
    if (
        status not in
        VALID_ATTENDANCE_STATUSES
    ):
        raise (
            InvalidAttendanceStatusError(
                "Invalid attendance status"
            )
        )


  # Lookup


def get_member_or_raise(
    db: Session,
    member_id: int,
):
    member = (
        db.query(Member)
        .filter(
            Member.id == member_id
        )
        .first()
    )


    if member is None:
        raise MemberNotFoundError(
            "Member not found"
        )


    return member


def get_attendance_by_id(
    db: Session,
    attendance_id: int,
):
    return (
        db.query(Attendance)
        .filter(
            Attendance.id
            == attendance_id
        )
        .first()
    )


def get_today_member_record(
    db: Session,
    member_id: int,
):
    today = (
        get_local_today()
    )


    return (
        db.query(Attendance)
        .filter(
            Attendance.member_id
            == member_id,

            Attendance.date
            == today,
        )
        .first()
    )

  # Record / Update


def record_today_attendance(
    db: Session,
    member_id: int,
    status: str,
):
    validate_status(
        status
    )


    get_member_or_raise(
        db,
        member_id,
    )


    now = (
        get_local_now()
    )

    today = (
        now.date()
    )

    recorded_time = (
        get_recorded_time(
            now
        )
    )


    attendance = (
        db.query(Attendance)
        .filter(
            Attendance.member_id
            == member_id,

            Attendance.date
            == today,
        )
        .first()
    )


    if attendance is None:
        attendance = Attendance(
            member_id=member_id,
            date=today,
            status=status,
            recorded_time=(
                recorded_time
            ),
        )

        db.add(
            attendance
        )

    else:
        attendance.status = (
            status
        )

        attendance.recorded_time = (
            recorded_time
        )


    try:
        db.commit()

        db.refresh(
            attendance
        )

        return attendance


    except IntegrityError:
        # در صورت Race Condition:
        #
        # Unique(member_id, date)
        # اجازه ایجاد Duplicate نمی‌دهد.
        #
        # رکورد موجود را پیدا کرده
        # و همان را Update می‌کنیم.

        db.rollback()


        attendance = (
            db.query(Attendance)
            .filter(
                Attendance.member_id
                == member_id,

                Attendance.date
                == today,
            )
            .first()
        )


        if attendance is None:
            raise


        attendance.status = (
            status
        )

        attendance.recorded_time = (
            recorded_time
        )


        try:
            db.commit()

            db.refresh(
                attendance
            )

            return attendance

        except SQLAlchemyError:
            db.rollback()

            raise


    except SQLAlchemyError:
        db.rollback()

        raise


def update_attendance_record(
    db: Session,
    attendance_id: int,
    status: str,
):
    validate_status(
        status
    )


    attendance = (
        get_attendance_by_id(
            db,
            attendance_id,
        )
    )


    if attendance is None:
        raise (
            AttendanceNotFoundError(
                "Attendance not found"
            )
        )


    attendance.status = (
        status
    )

    attendance.recorded_time = (
        get_recorded_time()
    )


    try:
        db.commit()

        db.refresh(
            attendance
        )

        return attendance

    except SQLAlchemyError:
        db.rollback()

        raise

   # Attendance History


def get_attendance_history(
    db: Session,
    *,
    member_id=None,
    skip=0,
    limit=100,
):
    query = (
        db.query(Attendance)
    )


    if member_id is not None:
        query = query.filter(
            Attendance.member_id
            == member_id
        )


    return (
        query
        .order_by(
            Attendance.date.desc(),
            Attendance.recorded_time.desc(),
            Attendance.id.desc(),
        )
        .offset(skip)
        .limit(limit)
        .all()
    )

  # Member Statistics


def get_member_attendance_summaries(
    db: Session,
):
    today = (
        get_local_today()
    )


    (
        month_start,
        next_month_start,
    ) = (
        get_current_persian_month_range(
            today
        )
    )


    total_present = (
        func.coalesce(
            func.sum(
                case(
                    (
                        Attendance.status
                        == "present",
                        1,
                    ),
                    else_=0,
                )
            ),
            0,
        )
        .label(
            "total_present"
        )
    )


    total_absent = (
        func.coalesce(
            func.sum(
                case(
                    (
                        Attendance.status
                        == "absent",
                        1,
                    ),
                    else_=0,
                )
            ),
            0,
        )
        .label(
            "total_absent"
        )
    )


    monthly_present = (
        func.coalesce(
            func.sum(
                case(
                    (
                        and_(
                            Attendance.status
                            == "present",

                            Attendance.date
                            >= month_start,

                            Attendance.date
                            < next_month_start,
                        ),
                        1,
                    ),
                    else_=0,
                )
            ),
            0,
        )
        .label(
            "monthly_present"
        )
    )


    monthly_absent = (
        func.coalesce(
            func.sum(
                case(
                    (
                        and_(
                            Attendance.status
                            == "absent",

                            Attendance.date
                            >= month_start,

                            Attendance.date
                            < next_month_start,
                        ),
                        1,
                    ),
                    else_=0,
                )
            ),
            0,
        )
        .label(
            "monthly_absent"
        )
    )


    today_status = (
        func.max(
            case(
                (
                    Attendance.date
                    == today,

                    Attendance.status,
                ),
                else_=None,
            )
        )
        .label(
            "today_status"
        )
    )


    today_recorded_time = (
        func.max(
            case(
                (
                    Attendance.date
                    == today,

                    Attendance.recorded_time,
                ),
                else_=None,
            )
        )
        .label(
            "today_recorded_time"
        )
    )


    rows = (
        db.query(
            Member,
            total_present,
            total_absent,
            monthly_present,
            monthly_absent,
            today_status,
            today_recorded_time,
        )
        .outerjoin(
            Attendance,
            Attendance.member_id
            == Member.id,
        )
        .group_by(
            Member.id
        )
        .order_by(
            Member.id.asc()
        )
        .all()
    )


    result = []


    for (
        member,
        total_present_value,
        total_absent_value,
        monthly_present_value,
        monthly_absent_value,
        today_status_value,
        recorded_time_value,
    ) in rows:

        result.append({
            "id":
                member.id,

            "first_name":
                member.first_name,

            "last_name":
                member.last_name,

            "phone":
                member.phone,

            "today_status":
                today_status_value,

            "total_present":
                int(
                    total_present_value
                    or 0
                ),

            "total_absent":
                int(
                    total_absent_value
                    or 0
                ),

            "monthly_present":
                int(
                    monthly_present_value
                    or 0
                ),

            "monthly_absent":
                int(
                    monthly_absent_value
                    or 0
                ),

            "recorded_time":
                recorded_time_value,
        })


    return result


  #Day Details


def get_attendance_day_details(
    db: Session,
    target_date: date,
):
    rows = (
        db.query(
            Attendance,
            Member,
        )
        .join(
            Member,
            Member.id
            == Attendance.member_id,
        )
        .filter(
            Attendance.date
            == target_date
        )
        .order_by(
            Member.first_name.asc(),
            Member.last_name.asc(),
        )
        .all()
    )


    present = []

    absent = []


    for (
        attendance,
        member,
    ) in rows:

        item = {
            "id":
                member.id,

            "first_name":
                member.first_name,

            "last_name":
                member.last_name,

            "phone":
                member.phone,

            "recorded_time":
                attendance.recorded_time,
        }


        if (
            attendance.status
            == "present"
        ):
            present.append(
                item
            )

        elif (
            attendance.status
            == "absent"
        ):
            absent.append(
                item
            )


    return {
        "date":
            target_date,

        "present":
            present,

        "absent":
            absent,
    }

   # Calendar Statistics


def get_calendar_statistics(
    db: Session,
    start_date: date,
    end_date: date,
):
    if (
        end_date
        < start_date
    ):
        raise ValueError(
            "end_date must be greater than or equal to start_date"
        )


    rows = (
        db.query(
            Attendance.date,

            func.sum(
                case(
                    (
                        Attendance.status
                        == "present",
                        1,
                    ),
                    else_=0,
                )
            )
            .label(
                "present_count"
            ),

            func.sum(
                case(
                    (
                        Attendance.status
                        == "absent",
                        1,
                    ),
                    else_=0,
                )
            )
            .label(
                "absent_count"
            ),
        )
        .filter(
            Attendance.date
            >= start_date,

            Attendance.date
            <= end_date,
        )
        .group_by(
            Attendance.date
        )
        .order_by(
            Attendance.date.asc()
        )
        .all()
    )


    counts = {
        row.date: {
            "present_count":
                int(
                    row.present_count
                    or 0
                ),

            "absent_count":
                int(
                    row.absent_count
                    or 0
                ),
        }
        for row in rows
    }


    result = []


    current_date = (
        start_date
    )


    while (
        current_date
        <= end_date
    ):
        values = counts.get(
            current_date,
            {
                "present_count": 0,
                "absent_count": 0,
            },
        )


        result.append({
            "date":
                current_date,

            "present_count":
                values[
                    "present_count"
                ],

            "absent_count":
                values[
                    "absent_count"
                ],
        })


        current_date += timedelta(
            days=1
        )


    return result