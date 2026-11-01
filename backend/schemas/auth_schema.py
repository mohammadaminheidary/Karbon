from pydantic import BaseModel, Field, ConfigDict, field_validator



class LoginRequest(BaseModel):

    username: str = Field(
        min_length=1,
        max_length=50
    )

    password: str = Field(
        min_length=1,
        max_length=72
    )





class LoginUser(BaseModel):

    id: int

    username: str


class LoginResponse(BaseModel):

    success: bool

    token: str

    user: LoginUser


class CredentialRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    current_password: str = Field(min_length=1, max_length=72)


class ChangePasswordRequest(CredentialRequest):
    new_password: str = Field(min_length=1, max_length=72)
    confirm_password: str = Field(min_length=1, max_length=72)

    @field_validator("new_password")
    @classmethod
    def valid_password(cls, value):
        if len(value.encode("utf-8")) > 72:
            raise ValueError("رمز عبور باید حداکثر ۷۲ بایت باشد؛ حروف فارسی چند بایت هستند.")
        if not value.strip():
            raise ValueError("رمز عبور نمی‌تواند فقط فاصله باشد.")
        return value

    @field_validator("confirm_password")
    @classmethod
    def matching_password(cls, value, info):
        if "new_password" in info.data and value != info.data["new_password"]:
            raise ValueError("تکرار رمز عبور با رمز جدید یکسان نیست.")
        return value
