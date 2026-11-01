import os

from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
from jose import JWTError, jwt


ENV_FILE = (
    Path.home()
    / ".karbon"
    / ".env"
)


load_dotenv(
    dotenv_path=ENV_FILE
)


SECRET_KEY = os.getenv(
    "KARBON_JWT_SECRET"
)


if not SECRET_KEY:

    raise RuntimeError(
        "KARBON_JWT_SECRET is not configured"
    )


ALGORITHM = "HS256"

ACCESS_TOKEN_EXPIRE_MINUTES = 60


def create_access_token(data: dict):

    to_encode = data.copy()


    expire = datetime.utcnow() + timedelta(

        minutes=ACCESS_TOKEN_EXPIRE_MINUTES

    )


    to_encode.update({

        "exp": expire

    })


    token = jwt.encode(

        to_encode,

        SECRET_KEY,

        algorithm=ALGORITHM

    )


    return token

def decode_access_token(token: str):

    try:

        payload = jwt.decode(
            token,
            SECRET_KEY,
            algorithms=[ALGORITHM],
            options={"require_exp": True, "require_sub": True},
        )

        return payload

    except JWTError:

        return None