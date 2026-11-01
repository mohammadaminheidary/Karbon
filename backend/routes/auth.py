from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
)

import hashlib

from sqlalchemy.orm import Session

from database import get_database

from models.user import User

from schemas.auth_schema import (
    LoginRequest,
    LoginResponse,
    ChangePasswordRequest,
)

from services.auth_service import authenticate_user
from services.auth_settings import auth_response, verify_current_password, change_credentials

from security.auth import get_current_user

from security.login_rate_limit import (
    login_budget,
    clear_login_failures,
    record_login_failure,
)


router = APIRouter(
    prefix="/api",
    tags=["Authentication"],
)


@router.post(
    "/login",
    response_model=LoginResponse,
)
def login(
    data: LoginRequest,
    request: Request,
    db: Session = Depends(get_database),
):

    client_key = (
        request.client.host
        if request.client
        else "unknown"
    )


    # Account keys are independent of client addresses and do not reveal existence.
    keys = (f"login-ip:{client_key}", "login-user:" + hashlib.sha256(data.username.encode()).hexdigest())
    with login_budget(keys) as (is_limited, retry_after):
        if is_limited:
            raise HTTPException(429, "تعداد تلاش‌های ورود بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.",
                                headers={"Retry-After": str(retry_after)})
        user = authenticate_user(db, data.username, data.password)
        if not user:
            for key in keys:
                record_login_failure(key)
            raise HTTPException(401, "نام کاربری یا رمز عبور اشتباه است")
        # A known account must not reset the IP's failed-password budget.
        clear_login_failures(keys[1])
        return auth_response(user)


@router.get("/auth/me")
def get_me(
    current_user: User = Depends(
        get_current_user
    ),
):

    return {
        "success": True,
        "user": {
            "id": current_user.id,
            "username": current_user.username,
        },
    }


@router.put("/auth/password", response_model=LoginResponse)
def change_password(data: ChangePasswordRequest, db: Session = Depends(get_database),
                    user: User = Depends(get_current_user)):
    verify_current_password(user, data.current_password)
    return change_credentials(db, user, password=data.new_password)


@router.post("/auth/logout", status_code=204)
def logout_session(db: Session = Depends(get_database),
                   user: User = Depends(get_current_user)):
    from sqlalchemy import update
    # Revoke every outstanding token for this account, including copied tokens.
    db.execute(update(User).where(User.id == user.id).values(
        auth_version=User.auth_version + 1))
    db.commit()
