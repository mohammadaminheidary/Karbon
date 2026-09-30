from datetime import datetime

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
)


def normalize_required_text(
    value,
):
    if not isinstance(value, str):
        return value

    value = value.strip()

    if not value:
        raise ValueError(
            "مقدار نمی‌تواند خالی باشد"
        )

    return value


def normalize_optional_text(
    value,
):
    if value is None:
        return None

    if not isinstance(value, str):
        return value

    value = value.strip()

    return value or None


class MemberCreate(BaseModel):

    model_config = ConfigDict(
        str_strip_whitespace=True,
    )


    first_name: str = Field(
        min_length=1,
        max_length=100,
    )

    last_name: str = Field(
        min_length=1,
        max_length=100,
    )

    phone: str | None = Field(
        default=None,
        max_length=20,
    )

    national_id: str | None = Field(
        default=None,
        max_length=20,
    )


    @field_validator(
    "first_name",
    "last_name",
    mode="before",
    )
    @classmethod
    def validate_name_fields(
        cls,
        value,
    ):
        if value is None:
            raise ValueError(
                "نام و نام خانوادگی نمی‌توانند null باشند"
            )

        return normalize_required_text(
            value
        )


    @field_validator(
        "phone",
        "national_id",
        mode="before",
    )
    @classmethod
    def validate_optional_text(
        cls,
        value,
    ):
        return normalize_optional_text(
            value
        )


class MemberUpdate(BaseModel):

    model_config = ConfigDict(
        str_strip_whitespace=True,
    )


    first_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=100,
    )

    last_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=100,
    )

    phone: str | None = Field(
        default=None,
        max_length=20,
    )

    national_id: str | None = Field(
        default=None,
        max_length=20,
    )


    @field_validator(
        "first_name",
        "last_name",
        mode="before",
    )
    @classmethod
    def validate_name_fields(
        cls,
        value,
    ):
        if value is None:
            return None

        return normalize_required_text(
            value
        )


    @field_validator(
        "phone",
        "national_id",
        mode="before",
    )
    @classmethod
    def validate_optional_text(
        cls,
        value,
    ):
        return normalize_optional_text(
            value
        )


class MemberResponse(BaseModel):

    model_config = ConfigDict(
        from_attributes=True,
    )


    id: int

    first_name: str

    last_name: str

    phone: str | None = None

    national_id: str | None = None

    created_at: datetime

    updated_at: datetime