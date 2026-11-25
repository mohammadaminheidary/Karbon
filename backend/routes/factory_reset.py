"""Verified administrator-only replacement of Karbon's active database."""
from base64 import b64encode
from hashlib import sha256
from hmac import compare_digest
from io import BytesIO
from secrets import choice, randbelow, token_hex
from time import time

from fastapi import APIRouter, Depends, HTTPException, Request
from PIL import Image, ImageDraw, ImageFont
from pydantic import Field
from sqlalchemy import text
from sqlalchemy.dialects.sqlite import insert
from starlette.concurrency import run_in_threadpool

from database import SessionLocal, get_database
from models.factory_reset import FactoryResetChallenge
from routes.backup import backup_errors
from schemas.auth_schema import CredentialRequest
from security.auth import bearer_scheme, get_current_user, require_admin
from security.login_rate_limit import MAX_ATTEMPTS, WINDOW_SECONDS, login_budget
from security.password import verify_password
from services.database_maintenance import exclusive_database_access
from services.reset_data import reset_operational_data


router = APIRouter(prefix="/api/settings/factory-reset", dependencies=[Depends(require_admin)], tags=["Factory reset"])
CONFIRMATION = "ریست داده‌های کاری"
CAPTCHA_LIFETIME = 180
CAPTCHA_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


class FactoryResetRequest(CredentialRequest):
    challenge_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    captcha: str = Field(pattern=r"^[A-Za-z2-9]{6}$")
    confirmation: str = Field(max_length=50)
    acknowledge: bool


def digest(value):
    return sha256(value.encode("utf-8")).hexdigest()


def captcha_image(answer):
    image = Image.new("RGB", (222, 64), "#f0f2f7")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=31)
    for _ in range(180):
        draw.point((randbelow(222), randbelow(64)), fill="#8794aa")
    for index, character in enumerate(answer):
        tile = Image.new("RGBA", (42, 48))
        ImageDraw.Draw(tile).text((8, 6), character, font=font, fill="#17263e")
        tile = tile.rotate(randbelow(35) - 17, resample=Image.Resampling.BICUBIC)
        image.paste(tile, (5 + index * 35, randbelow(14)), tile)
    for _ in range(4):
        draw.line((0, randbelow(64), 221, randbelow(64)), fill="#79869e", width=1)
    output = BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + b64encode(output.getvalue()).decode("ascii")


def limited_response(retry):
    return HTTPException(429, "تعداد تلاش‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.",
                         headers={"Retry-After": str(retry)})


def check_attempts(challenge, now):
    if challenge and challenge.failed_attempts >= MAX_ATTEMPTS:
        remaining = WINDOW_SECONDS - (now - challenge.failure_window)
        if remaining > 0:
            raise limited_response(remaining)


@router.post("/challenge")
def create_challenge(db=Depends(get_database), user=Depends(require_admin), credentials=Depends(bearer_scheme)):
    user_id = user.id
    with backup_errors("ساخت کپچای محلی انجام نشد. دوباره تلاش کنید."), \
            login_budget((f"factory-reset:{user_id}",)) as (limited, retry):
        if limited:
            raise limited_response(retry)
        answer = "".join(choice(CAPTCHA_ALPHABET) for _ in range(6))
        challenge_id = token_hex(16)
        db.rollback()
        db.execute(text("BEGIN IMMEDIATE"))
        now = int(time())
        previous = db.get(FactoryResetChallenge, user_id)
        check_attempts(previous, now)
        if previous and now - previous.issued_at < 2:
            raise limited_response(2)
        fields = {"challenge_id": challenge_id, "owner": digest(credentials.credentials),
                  "answer_digest": digest(challenge_id + answer), "issued_at": now, "consumed": False}
        db.execute(insert(FactoryResetChallenge).values(user_id=user_id, **fields).on_conflict_do_update(
            index_elements=[FactoryResetChallenge.user_id], set_=fields))
        db.commit()
        return {"challenge_id": challenge_id, "image": captcha_image(answer), "expires_in": CAPTCHA_LIFETIME}


def authorize_reset(db, user, credentials, body):
    user_id, password_hash = user.id, user.password_hash
    key = f"factory-reset:{user_id}"
    with login_budget((key,)) as (limited, retry):
        if limited:
            raise limited_response(retry)
        db.rollback()
        db.execute(text("BEGIN IMMEDIATE"))
        now = int(time())
        challenge = db.get(FactoryResetChallenge, user_id)
        check_attempts(challenge, now)
        if not challenge:
            challenge = FactoryResetChallenge(user_id=user_id, challenge_id="", owner="", answer_digest="",
                                              issued_at=0, consumed=True, failed_attempts=0, failure_window=0)
            db.add(challenge)
        valid = False
        if (not challenge.consumed and compare_digest(challenge.challenge_id, body.challenge_id)
                and compare_digest(challenge.owner, digest(credentials.credentials))):
            valid = (0 <= now - challenge.issued_at < CAPTCHA_LIFETIME
                     and compare_digest(challenge.answer_digest, digest(body.challenge_id + body.captcha.upper())))
            challenge.consumed = True
        if not valid or not verify_password(body.current_password, password_hash):
            if now - challenge.failure_window >= WINDOW_SECONDS:
                challenge.failure_window = now
                challenge.failed_attempts = 0
            challenge.failed_attempts += 1
            db.commit()
            raise HTTPException(403, "رمز فعلی یا کپچا صحیح نیست، یا اعتبار کپچا پایان یافته است. کپچای تازه بگیرید.")
        db.commit()


def reset_database(credentials):
    # All outstanding writes have drained. Revalidate the session before publishing.
    with SessionLocal() as db:
        require_admin(get_current_user(credentials, db))
    reset_operational_data()


@router.post("")
async def factory_reset(body: FactoryResetRequest, request: Request, db=Depends(get_database),
                        user=Depends(require_admin), credentials=Depends(bearer_scheme)):
    if not body.acknowledge or body.confirmation != CONFIRMATION:
        raise HTTPException(422, "عبارت تأیید را دقیق وارد کنید و حذف دائمی داده‌ها را تأیید کنید.")
    with backup_errors("بازنشانی انجام نشد. دوباره وارد شوید و وضعیت اطلاعات را بررسی کنید."):
        await run_in_threadpool(authorize_reset, db, user, credentials, body)
        await run_in_threadpool(db.close)
        async with exclusive_database_access(request.state.database_lease):
            await run_in_threadpool(reset_database, credentials)
    return {"status": "completed"}
