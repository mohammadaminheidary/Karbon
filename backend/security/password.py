"""bcrypt with an explicit work factor and no silent UTF-8 truncation."""
import bcrypt

BCRYPT_ROUNDS = 12


def hash_password(password: str):
    raw = password.encode("utf-8")
    if not raw or len(raw) > 72:
        raise ValueError("Password must contain 1 to 72 UTF-8 bytes")
    return bcrypt.hashpw(raw, bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode("utf-8")


def verify_password(password: str, password_hash: str):
    raw = password.encode("utf-8")
    if not raw or len(raw) > 72:
        return False
    try:
        return bcrypt.checkpw(raw, password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def needs_rehash(password_hash):
    try:
        return int(password_hash.split("$")[2]) < BCRYPT_ROUNDS
    except (ValueError, IndexError):
        return False
