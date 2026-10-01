from fastapi import FastAPI

from fastapi.middleware.cors import (
    CORSMiddleware,
)

from database import (
    Base,
    engine,
)

import models

from routes.auth import (
    router as auth_router,
)

from routes.members import (
    router as members_router,
)

from routes.attendance import (
    router as attendance_router,
)


# ======================================================
# Application
# ======================================================


app = FastAPI(
    title="Karbon API",
    version="1.0.0",
)


# ======================================================
# Database
# ======================================================

# تمام Modelها قبل از create_all
# از طریق import models لود شده‌اند.
Base.metadata.create_all(
    bind=engine
)


# ======================================================
# CORS
# ======================================================

app.add_middleware(
    CORSMiddleware,

    allow_origins=[
        "http://127.0.0.1:5501",
        "http://localhost:5501",
    ],

    allow_credentials=False,

    allow_methods=[
        "GET",
        "POST",
        "PUT",
        "DELETE",
    ],

    allow_headers=[
        "Content-Type",
        "Authorization",
    ],
)


# ======================================================
# Routers
# ======================================================

app.include_router(
    auth_router
)


app.include_router(
    members_router
)


app.include_router(
    attendance_router
)


# ======================================================
# Health
# ======================================================


@app.get("/")
def home():
    return {
        "status": "running",
        "message": (
            "Karbon Backend is running"
        ),
    }