"""Open only Karbon's backup directory, and only for local desktop requests."""
import ipaddress
import os
from pathlib import Path
import shutil
import subprocess
import sys
from threading import Thread
from urllib.parse import urlsplit

from services.backup_service import backup_directory, BackupError


REMOTE = "پوشه پشتیبان فقط هنگام استفاده از کاربن روی همین رایانه باز می‌شود."
HEADLESS = "روی میزبان کاربن نشست گرافیکی یا مدیر فایل در دسترس نیست."


def loopback(host):
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(host)
        return (getattr(ip, "ipv4_mapped", None) or ip).is_loopback
    except ValueError:
        return False


def local_browser(request):
    if not request.client or not loopback(request.client.host):
        return False
    if any(name.startswith("x-forwarded-") or name in {"forwarded", "via", "x-real-ip"}
           for name in request.headers):
        return False
    try:
        browser = request.headers.get("origin") or request.headers.get("referer")
        url = urlsplit(browser or "")
        return (loopback(request.url.hostname) and url.scheme in {"http", "https"}
                and loopback(url.hostname))
    except ValueError:
        return False


def desktop_opener():
    if sys.platform == "darwin":
        try:
            console_user = os.stat("/dev/console").st_uid
        except OSError:
            return None
        if console_user == os.getuid() and Path("/usr/bin/open").is_file():
            return "/usr/bin/open"
    elif os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class UserObjectFlags(ctypes.Structure):
            _fields_ = [("inherit", wintypes.BOOL), ("reserved", wintypes.BOOL), ("flags", wintypes.DWORD)]

        user32 = ctypes.windll.user32
        user32.GetProcessWindowStation.restype = wintypes.HANDLE
        user32.GetUserObjectInformationW.argtypes = (
            wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, wintypes.LPDWORD)
        flags = UserObjectFlags()
        needed = wintypes.DWORD()
        if user32.GetUserObjectInformationW(user32.GetProcessWindowStation(), 1, ctypes.byref(flags),
                                            ctypes.sizeof(flags), ctypes.byref(needed)) and flags.flags & 1:
            return os.startfile
    elif sys.platform.startswith("linux"):
        wayland = os.getenv("WAYLAND_DISPLAY")
        runtime = os.getenv("XDG_RUNTIME_DIR")
        display = os.getenv("DISPLAY", "")
        x11 = display.split(".")[0].removeprefix(":")
        if ((wayland and runtime and (Path(runtime) / wayland).is_socket())
                or (display.startswith(":") and x11.isdecimal() and Path(f"/tmp/.X11-unix/X{x11}").is_socket())):
            return shutil.which("xdg-open")
    return None


def folder_access(request):
    if not local_browser(request):
        return None, REMOTE
    opener = desktop_opener()
    return (opener, None) if opener else (None, HEADLESS)


def open_backup_folder(request):
    opener, reason = folder_access(request)
    if not opener:
        raise BackupError(reason, 403)
    path = backup_directory()
    if callable(opener):
        opener(str(path))
        return
    command = [opener, str(path)]
    options = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if sys.platform == "darwin":
        subprocess.run(command, check=True, timeout=8, **options)
        return
    # xdg-open can stay alive for the file manager's lifetime.
    process = subprocess.Popen(command, **options)
    try:
        if process.wait(timeout=2):
            raise OSError("The file manager did not accept the backup folder")
    except subprocess.TimeoutExpired:
        Thread(target=process.wait, daemon=True).start()
