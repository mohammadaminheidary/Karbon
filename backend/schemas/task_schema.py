from datetime import date as Date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from schemas.finance_schema import parse_jalali


TaskStatus = Literal["todo", "in_progress", "completed"]


class TaskCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    date: Date
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)

    @field_validator("date", mode="before")
    @classmethod
    def task_date(cls, value):
        # Keep ISO dates compatible with existing clients and stored records;
        # the page submits Jalali dates using the shared project converter.
        return parse_jalali(value) if isinstance(value, str) and "/" in value else value


class TaskStatusUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: TaskStatus


class TaskResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    date: Date
    title: str
    description: str
    status: TaskStatus
    created_at: datetime
