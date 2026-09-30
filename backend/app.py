from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import engine, Base

import models

from routes.auth import router as auth_router
from routes.members import router as members_router


# ایجاد برنامه FastAPI
app = FastAPI(
    title="Karbon API",
    version="1.0.0",
)


# ساخت جدول‌های دیتابیس
Base.metadata.create_all(
    bind=engine
)


# تنظیم CORS برای اتصال Frontend
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


# ثبت Route های احراز هویت
app.include_router(
    auth_router
)

app.include_router(
    members_router
)

# تست سلامت Backend
@app.get("/")
def home():

    return {
        "status": "running",
        "message": "Karbon Backend is running",
    }