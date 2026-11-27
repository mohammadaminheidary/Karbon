from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class ReminderSettings(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    reminder_enabled: bool
    reminder_hours: int = Field(ge=1, le=8760)


class DashboardWidget(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    x: int
    y: int
    w: int
    h: int


class DashboardLayout(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    version: Literal[1]
    layouts: dict[Literal["desktop", "tablet", "mobile"], Annotated[list[DashboardWidget], Field(max_length=64)]]


class BrowserPreferences(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    appearance: dict[str, str | int | bool | dict[str, int | bool]] | None = Field(max_length=32)
    dashboard_layout: DashboardLayout | None
