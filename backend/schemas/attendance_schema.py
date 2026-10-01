from datetime import (
    date,
    datetime,
    time,
)

from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
)


AttendanceStatus = Literal[
    "present",
    "absent",
]


class AttendanceCreate(BaseModel):

    member_id: int = Field(
        gt=0,
    )

    status: AttendanceStatus


class AttendanceUpdate(BaseModel):

    status: AttendanceStatus


class AttendanceRecordResponse(BaseModel):

    model_config = ConfigDict(
        from_attributes=True,
    )


    id: int

    member_id: int

    date: date

    status: AttendanceStatus

    recorded_time: time

    created_at: datetime

    updated_at: datetime


class AttendanceMemberSummary(BaseModel):

    id: int

    first_name: str

    last_name: str

    phone: str | None = None

    today_status: AttendanceStatus | None = None

    total_present: int = 0

    total_absent: int = 0

    monthly_present: int = 0

    monthly_absent: int = 0

    recorded_time: time | None = None


class AttendanceDayMember(BaseModel):

    id: int

    first_name: str

    last_name: str

    phone: str | None = None

    recorded_time: time | None = None


class AttendanceDayDetailsResponse(BaseModel):

    date: date

    present: list[
        AttendanceDayMember
    ]

    absent: list[
        AttendanceDayMember
    ]


class AttendanceCalendarDayResponse(BaseModel):

    date: date

    present_count: int = 0

    absent_count: int = 0