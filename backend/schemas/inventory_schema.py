from pydantic import BaseModel, ConfigDict, Field, field_validator
from schemas.customer_schema import normalize_text


class InventoryOptionWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=80)
    active: bool = Field(default=True, strict=True)

    @field_validator("name", mode="before")
    @classmethod
    def normalized_name(cls, value):
        return normalize_text(value) if isinstance(value, str) else value
