"""Credential verification uses equivalent bcrypt work for unknown accounts."""
from sqlalchemy import update
from models.user import User
from security.password import hash_password, verify_password, needs_rehash

_DUMMY_HASH = hash_password("non-account verification placeholder")


def authenticate_user(db, username, password):
    user = db.query(User).filter(User.username == username).first()
    valid = verify_password(password, user.password_hash if user else _DUMMY_HASH)
    if not user or not valid:
        return None
    if needs_rehash(user.password_hash):
        # Do not overwrite a password changed concurrently with this login.
        old_hash = user.password_hash
        result = db.execute(update(User).where(
            User.id == user.id, User.password_hash == old_hash,
        ).values(password_hash=hash_password(password)),
            execution_options={"synchronize_session": False})
        if result.rowcount != 1:
            db.rollback()
            return None
        db.commit()
        db.refresh(user)
    return user
