from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    status,
)

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
    check_login_rate_limit,
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


    is_limited, retry_after = (
        check_login_rate_limit(
            client_key
        )
    )


    if is_limited:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                "تعداد تلاش‌های ورود بیش از حد مجاز است. "
                "کمی بعد دوباره تلاش کنید."
            ),
            headers={
                "Retry-After": str(
                    retry_after
                )
            },
        )


    user = authenticate_user(
        db,
        data.username,
        data.password,
    )


    if not user:
        record_login_failure(
            client_key
        )

        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=(
                "نام کاربری یا رمز عبور اشتباه است"
            ),
        )


    clear_login_failures(
        client_key
    )


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
