from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field


class ReportFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: str = Field(max_length=150)
    op: Literal["eq", "gte", "lte", "is_null"] = "eq"
    value: Any = None


class ReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    report_name: str = Field(default="", max_length=200)
    columns: list[str] | None = Field(default=None, max_length=250)
    filters: list[ReportFilter] = Field(default_factory=list, max_length=30)
    search: str = Field(default="", max_length=200)
    include_deleted: bool = False
    ids: list[int | str] | None = Field(default=None, max_length=50000)
    excluded_ids: list[int | str] = Field(default_factory=list, max_length=50000)
    offset: int = Field(default=0, ge=0, le=10000000)
    limit: int = Field(default=50, ge=1, le=200)
