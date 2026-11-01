"""Credential changes and the small, additive migration for existing accounts."""
from sqlalchemy import inspect, text, update
from sqlalchemy.exc import IntegrityError
from fastapi import HTTPException

from models.user import User
from security.password import hash_password, verify_password
from security.login_rate_limit import (
    login_budget, record_login_failure, clear_login_failures,
)


def initialize_auth_storage(engine):
    with engine.begin() as connection:
        if "auth_version" not in {c["name"] for c in inspect(connection).get_columns("users")}:
            connection.execute(text("ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0"))


def auth_response(user):
    from security.jwt import create_access_token

    return {
        "success": True,
        "token": create_access_token({"sub": user.username, "uid": user.id, "ver": user.auth_version}),
        "user": {"id": user.id, "username": user.username},
    }


def verify_current_password(user, password):
    # Account based, independent of login attempts.
    key = f"credentials:{user.id}"
    with login_budget((key,)) as (limited, retry):
        if limited:
            raise HTTPException(429, "تعداد تلاش‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.",
                                headers={"Retry-After": str(retry)})
        if not verify_password(password, user.password_hash):
            record_login_failure(key)
            raise HTTPException(403, detail={"field": "current_password", "message": "رمز عبور فعلی صحیح نیست."})
        clear_login_failures(key)


def change_credentials(db, user, *, password):
    changes = {"auth_version": user.auth_version + 1}
    if password is not None:
        if verify_password(password, user.password_hash):
            raise HTTPException(422, detail={"field": "new_password", "message": "رمز عبور جدید باید با رمز فعلی متفاوت باشد."})
        changes["password_hash"] = hash_password(password)
    try:
        # Reject a competing update that already replaced these credentials.
        result = db.execute(update(User).where(
            User.id == user.id, User.auth_version == user.auth_version,
        ).values(**changes), execution_options={"synchronize_session": False})
        if result.rowcount != 1:
            db.rollback()
            raise HTTPException(409, "اطلاعات ورود تغییر کرده است. صفحه را تازه‌سازی کنید.")
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "ذخیره رمز عبور انجام نشد. دوباره تلاش کنید.") from None
    db.refresh(user)
    return auth_response(user)
