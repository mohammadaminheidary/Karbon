import uvicorn
import os
from pathlib import Path


if __name__ == "__main__":

    os.chdir(Path(__file__).resolve().parent)

    uvicorn.run(
        "app:app",
        app_dir=str(Path(__file__).resolve().parent),
        host="127.0.0.1",
        port=8000,
        reload=True
    )
