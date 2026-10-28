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
from routes.customers import router as customers_router
from routes.finance import router as finance_router
from routes.orders import router as orders_router
from routes.inventory import router as inventory_settings_router
from routes.tasks import router as tasks_router
from routes.documents import router as documents_router, settings_router as document_settings_router
from services.finance_service import initialize_bank_storage
from services.order_service import initialize_order_storage
from services.document_service import initialize_document_storage
from routes.faces import router as faces_router
from routes.dashboard import router as dashboard_router
from security.face_requests import FaceRequestMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.responses import JSONResponse


# ======================================================
# Application
# ======================================================


app = FastAPI(
    title="Karbon API",
    version="1.0.0",
)


@app.exception_handler(RequestValidationError)
async def private_face_validation(request, error):
    if request.url.path.startswith("/api/faces"):
        # Pydantic's default error includes input values (including biometrics).
        return JSONResponse({"detail": {"code": "INVALID_INPUT", "message": "تصاویر معتبر با تعداد مناسب و رضایت ثبت چهره لازم است."}}, status_code=422)
    return await request_validation_exception_handler(request, error)


app.add_middleware(FaceRequestMiddleware)


# ======================================================
# Database
# ======================================================

# تمام Modelها قبل از create_all
# از طریق import models لود شده‌اند.
Base.metadata.create_all(
    bind=engine
)
initialize_bank_storage(engine)
initialize_document_storage(engine)
initialize_order_storage(engine)


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
    expose_headers=["Retry-After"],

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
app.include_router(customers_router)
app.include_router(finance_router)
app.include_router(orders_router)
app.include_router(inventory_settings_router)
app.include_router(tasks_router)
app.include_router(documents_router)
app.include_router(document_settings_router)
app.include_router(faces_router)
app.include_router(dashboard_router)


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
