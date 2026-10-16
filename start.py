import subprocess
import sys
import time
import webbrowser
import socket
import shutil
from pathlib import Path


# مسیر اصلی پروژه
BASE_DIR = Path(__file__).resolve().parent


# مسیرها
BACKEND_DIR = BASE_DIR / "backend"


# تنظیمات
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8000

FRONTEND_HOST = "127.0.0.1"
FRONTEND_PORT = 5501

LOGIN_URL = (
    f"http://{FRONTEND_HOST}:{FRONTEND_PORT}"
    "/page/login-page.html"
)


def build_frontend():
    subprocess.run(
        [sys.executable, str(BASE_DIR / "scripts/build_navigation.py")],
        cwd=BASE_DIR,
        check=True,
    )
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("Node.js/npm is required to build styles. Install Node.js and run npm install.")
    print("Building frontend styles...")
    subprocess.run(
        [npm, "exec", "--", "tailwindcss", "-i", "./src/input.css", "-o", "./src/output.css"],
        cwd=BASE_DIR,
        check=True,
    )



def is_port_available(
    host,
    port
):

    with socket.socket(
        socket.AF_INET,
        socket.SOCK_STREAM
    ) as sock:

        return (
            sock.connect_ex(
                (host, port)
            )
            != 0
        )



def start_backend():

    print(
        "Starting Backend..."
    )


    process = subprocess.Popen(

        [
            sys.executable,
            "-m",
            "uvicorn",
            "app:app",
            "--reload",
            "--host",
            BACKEND_HOST,
            "--port",
            str(BACKEND_PORT)
        ],

        cwd=BACKEND_DIR

    )


    return process



def start_frontend():

    print(
        "Starting Frontend..."
    )


    process = subprocess.Popen(

        [
            sys.executable,
            str(BASE_DIR / "serve_frontend.py")
        ],

        cwd=BASE_DIR

    )


    return process



def open_browser():

    print(
        "Opening Karbon..."
    )


    time.sleep(3)


    webbrowser.open(
        LOGIN_URL
    )



def main():


    print(
        "\n======================"
    )

    print(
        " Starting Karbon "
    )

    print(
        "======================\n"
    )



    backend_process = None

    frontend_process = None



    try:

        build_frontend()

        # Backend
        if is_port_available(
            BACKEND_HOST,
            BACKEND_PORT
        ):

            backend_process = start_backend()

        else:

            print(
                "Backend already running"
            )



        # Frontend
        if is_port_available(
            FRONTEND_HOST,
            FRONTEND_PORT
        ):

            frontend_process = start_frontend()

        else:

            print(
                "Frontend already running"
            )



        open_browser()



        print(
            "\nKarbon is running:"
        )


        print(
            f"Backend: http://{BACKEND_HOST}:{BACKEND_PORT}"
        )


        print(
            f"Frontend: http://{FRONTEND_HOST}:{FRONTEND_PORT}"
        )


        print(
            "\nPress CTRL+C to stop\n"
        )



        while True:

            time.sleep(1)



    except KeyboardInterrupt:


        print(
            "\nStopping Karbon..."
        )



        if backend_process:

            backend_process.terminate()



        if frontend_process:

            frontend_process.terminate()



        print(
            "Karbon stopped"
        )




if __name__ == "__main__":

    main()
