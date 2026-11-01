from getpass import getpass

from database import Base, engine, SessionLocal

from models.user import User

from security.password import hash_password
from services.auth_settings import initialize_auth_storage



# ساخت جدول‌ها
Base.metadata.create_all(bind=engine)
initialize_auth_storage(engine)



password = getpass("New admin password: ")
password_confirm = getpass("Repeat admin password: ")


if password != password_confirm:
    raise ValueError("Passwords do not match")


password_length = len(
    password.encode("utf-8")
)


if password_length < 8:
    raise ValueError(
        "Password must be at least 8 bytes long"
    )


if password_length > 72:
    raise ValueError(
        "Password must not exceed 72 bytes"
    )


db = SessionLocal()


try:

    user = (
        db.query(User)
        .filter(User.username == "admin")
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

            username="admin",

            password_hash=hash_password(
                password
            )

        )

        db.add(user)

        message = "Admin user created"


    db.commit()


finally:

    db.close()


print(message)
