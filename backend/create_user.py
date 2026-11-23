from getpass import getpass
from config import ADMIN_USERNAME

from database import Base, engine, SessionLocal

from models.user import User

from security.password import hash_password
from services.auth_settings import initialize_auth_storage
from services.database_maintenance import database_access



password = getpass("New admin password: ")
password_confirm = getpass("Repeat admin password: ")


if password != password_confirm:
    raise ValueError("Passwords do not match")


password_length = len(
    password.encode("utf-8")
)


if len(password) < 15:
    raise ValueError(
        "Password must be at least 15 characters long"
    )


if password_length > 72:
    raise ValueError(
        "Password must not exceed 72 bytes"
    )


with database_access(), SessionLocal() as db:

    Base.metadata.create_all(bind=engine)
    initialize_auth_storage(engine)

    user = (
        db.query(User)
        .filter(User.username == ADMIN_USERNAME)
        .first()
    )


    if user:

        user.password_hash = hash_password(
            password
        )
        user.auth_version += 1

        message = "Admin password updated"

    else:

        user = User(

            username=ADMIN_USERNAME,

            password_hash=hash_password(
                password
            )

        )

        db.add(user)

        message = "Admin user created"


    db.commit()


print(message)
