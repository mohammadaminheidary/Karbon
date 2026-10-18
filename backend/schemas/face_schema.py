from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


ImageSample = Annotated[str, Field(min_length=32, max_length=500_000)]


class FaceSamples(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Two independent recognition frames; accept legacy three-frame clients.
    images: list[ImageSample] = Field(min_length=2, max_length=3)


class FaceRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    images: list[ImageSample] = Field(min_length=3, max_length=3)
    consent: Literal[True]


class FaceValidation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    images: list[ImageSample] = Field(min_length=1, max_length=3)
    consent: Literal[True]


class FaceGuide(BaseModel):
    model_config = ConfigDict(extra="forbid")
    image: ImageSample
    angle: Literal["front", "left", "right"]
    # Guidance only. Final validation derives its baseline from the photos.
    reference: tuple[Annotated[float, Field(ge=-1, le=1, allow_inf_nan=False)],
                     Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]] | None = None
    consent: Literal[True]


class ManualCheckIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    member_id: int = Field(gt=0)
