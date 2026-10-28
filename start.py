"""Build and launch Karbon from any working directory."""
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

BASE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = BASE_DIR / "backend"
FRONTEND_DIR = BASE_DIR / "frontend"
BACKEND_HOST, BACKEND_PORT = "127.0.0.1", 8000
FRONTEND_HOST, FRONTEND_PORT = "127.0.0.1", 5501
BACKEND_URL = f"http://{BACKEND_HOST}:{BACKEND_PORT}"
LOGIN_URL = f"http://{FRONTEND_HOST}:{FRONTEND_PORT}/page/login-page.html"


def spawn(command, cwd):
    # Uvicorn's reload worker and build subprocesses share their parent's group.
    return subprocess.Popen(command, cwd=cwd, start_new_session=os.name == "posix")


def stop_process(process):
    if process is None:
        return
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    elif process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        process.wait(timeout=5)


def run_build(command):
    process = spawn(command, FRONTEND_DIR)
    try:
        code = process.wait()
        if code:
            raise subprocess.CalledProcessError(code, command)
    finally:
        stop_process(process)


def build_frontend():
    run_build([sys.executable, str(FRONTEND_DIR / "scripts/build_navigation.py")])
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("Node.js/npm is required. Install Node.js and run npm --prefix frontend install.")
    # Use the installed CLI directly so a missing dependency cannot cause npm
    # exec to download a different version while launching the application.
    cli = FRONTEND_DIR / "node_modules/.bin/tailwindcss"
    if os.name == "nt":
        cli = cli.with_suffix(".cmd")
    if not cli.is_file():
        raise RuntimeError("Frontend dependencies are missing. Run npm --prefix frontend install.")
    print("Building frontend styles...", flush=True)
    run_build([str(cli), "-i", "./src/input.css", "-o", "./src/output.css"])


def is_port_available(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex((host, port)) != 0


def start_backend():
    print("Starting Backend...", flush=True)
    return spawn([
        sys.executable, "-m", "uvicorn", "app:app", "--reload",
        "--host", BACKEND_HOST, "--port", str(BACKEND_PORT),
    ], BACKEND_DIR)


def start_frontend():
    print("Starting Frontend...", flush=True)
    return spawn([sys.executable, str(FRONTEND_DIR / "serve_frontend.py")], FRONTEND_DIR)


def wait_until_ready(url, processes, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for name, process in processes:
            if process is not None and process.poll() is not None:
                raise RuntimeError(f"{name} exited with code {process.returncode}")
        try:
            with urlopen(url, timeout=0.5) as response:
                if response.status == 200:
                    return
        except (OSError, URLError):
            pass
        time.sleep(0.1)
    raise RuntimeError(f"Server did not become ready: {url}")


def open_browser():
    print("Opening Karbon...", flush=True)
    webbrowser.open(LOGIN_URL)


def main():
    print("\nStarting Karbon\n", flush=True)
    backend_process = frontend_process = None
    previous_handlers = {}

    def interrupt(_signum, _frame):
        raise KeyboardInterrupt

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.signal(signum, interrupt)
        build_frontend()
        if is_port_available(BACKEND_HOST, BACKEND_PORT):
            backend_process = start_backend()
        else:
            print("Backend already running", flush=True)
        if is_port_available(FRONTEND_HOST, FRONTEND_PORT):
            frontend_process = start_frontend()
        else:
            print("Frontend already running", flush=True)
        processes = [("Backend", backend_process), ("Frontend", frontend_process)]
        wait_until_ready(BACKEND_URL, processes)
        wait_until_ready(LOGIN_URL, processes)
        open_browser()
        print(f"\nKarbon is running:\nBackend: {BACKEND_URL}\n"
              f"Frontend: http://{FRONTEND_HOST}:{FRONTEND_PORT}\n"
              "\nPress CTRL+C to stop\n", flush=True)
        while True:
            for name, process in processes:
                if process is not None and process.poll() is not None:
                    raise RuntimeError(f"{name} exited with code {process.returncode}")
            time.sleep(0.25)
    except KeyboardInterrupt:
        print("\nStopping Karbon...", flush=True)
        return 0
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Karbon could not continue: {error}", file=sys.stderr, flush=True)
        return 1
    finally:
        # A second signal during cleanup must not leave reload workers behind.
        for signum in previous_handlers:
            signal.signal(signum, signal.SIG_IGN)
        try:
            stop_process(frontend_process)
        finally:
            try:
                stop_process(backend_process)
            finally:
                for signum, handler in previous_handlers.items():
                    signal.signal(signum, handler)
        print("Karbon stopped", flush=True)


if __name__ == "__main__":
    sys.exit(main())
