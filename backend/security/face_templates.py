"""Encrypt templates with a dedicated key, separate from login tokens and DB."""
import os
import stat
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from config import DATABASE_PATH


def template_cipher(*, create=False):
    configured = os.getenv("KARBON_FACE_KEY")
    if configured:
        return Fernet(configured.encode("ascii"))

    path = Path(os.getenv("KARBON_FACE_KEY_PATH", str(DATABASE_PATH.parent / "face.key"))).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Never silently create a replacement key for existing encrypted data.
    # O_EXCL also prevents two workers from overwriting each other's key.
    if create:
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "wb") as target:
                target.write(Fernet.generate_key())
    file_mode = path.lstat().st_mode
    if not stat.S_ISREG(file_mode) or stat.S_IMODE(file_mode) & 0o077:
        raise ValueError("Face key must be a private regular file (0600)")
    return Fernet(path.read_bytes())


def encrypt_template(member_id, features):
    # Bind ciphertext to the member so moving a DB blob cannot swap identities.
    return template_cipher(create=True).encrypt(str(member_id).encode() + b":" + features)


def decrypt_template(member_id, encrypted):
    payload = template_cipher().decrypt(encrypted)
    prefix = str(member_id).encode() + b":"
    if not payload.startswith(prefix):
        raise InvalidToken()
    return payload[len(prefix):]
