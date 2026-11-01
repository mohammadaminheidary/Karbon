from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware

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
from services.inventory_service import initialize_unit_storage
from services.document_service import initialize_document_storage
from services.customer_ids import initialize_customer_ids
from services.auth_settings import initialize_auth_storage
from routes.faces import router as faces_router
from routes.dashboard import router as dashboard_router
from routes.reports import router as reports_router
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


class PrivateResponseMiddleware:
    """Set privacy headers without converting buffered responses to streams."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def private_send(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                if scope["path"].startswith("/api/"):
                    headers = [(k, v) for k, v in headers if k.lower() not in {b"cache-control", b"pragma"}]
                    headers.extend([(b"cache-control", b"no-store"), (b"pragma", b"no-cache")])
                headers.append((b"x-content-type-options", b"nosniff"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, private_send)


app.add_middleware(PrivateResponseMiddleware)


@app.exception_handler(RequestValidationError)
async def private_face_validation(request, error):
    if request.url.path.startswith("/api/faces"):
        # Pydantic's default error includes input values (including biometrics).
        return JSONResponse({"detail": {"code": "INVALID_INPUT", "message": "تصاویر معتبر با تعداد مناسب و رضایت ثبت چهره لازم است."}}, status_code=422)
    if request.url.path == "/api/login" or request.url.path.startswith("/api/auth/"):
        # Validation errors must never echo passwords or request bodies.
        errors = [{"field": str(e["loc"][-1]), "message": e["msg"].removeprefix("Value error, ")} for e in error.errors()]
        return JSONResponse({"detail": errors}, status_code=422)
    return await request_validation_exception_handler(request, error)


class NegotiatedGZipMiddleware(GZipMiddleware):
    async def __call__(self, scope, receive, send):
        # Starlette checks for the substring "gzip"; honor clients that explicitly
        # disable it with q=0 while keeping its normal identity/Vary handling.
        encoding = next((v for k, v in scope.get("headers", []) if k == b"accept-encoding"), b"")
        if b";" in encoding and b"gzip" in encoding.lower():
            tokens = encoding.decode("latin-1").split(",")
            allowed = []
            for token in tokens:
                parts = token.split(";")
                disabled = False
                if parts[0].strip().lower() == "gzip":
                    for parameter in parts[1:]:
                        name, _, value = parameter.partition("=")
                        if name.strip().lower() == "q":
                            try:
                                disabled = not 0 < float(value) <= 1
                            except ValueError:
                                disabled = True
                if not disabled:
                    allowed.append(token)
            scope = {**scope, "headers": [(k, ",".join(allowed).encode("latin-1") if k == b"accept-encoding" else v) for k, v in scope["headers"]]}
        await super().__call__(scope, receive, send)


app.add_middleware(FaceRequestMiddleware)
# Large JSON lists compress well at level 1 without the CPU cost of level 9.
# Small auth, error, and face-status responses bypass compression entirely.
app.add_middleware(NegotiatedGZipMiddleware, minimum_size=1024, compresslevel=1)


# ======================================================
# Database
# ======================================================

# تمام Modelها قبل از create_all
# از طریق import models لود شده‌اند.
Base.metadata.create_all(
    bind=engine
)
initialize_auth_storage(engine)
initialize_customer_ids(engine)
initialize_bank_storage(engine)
initialize_document_storage(engine)
initialize_order_storage(engine)
initialize_unit_storage(engine)


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

@app.get("/api/health", include_in_schema=False)
async def health():
    """Cheap, unauthenticated reachability check; no database or session work."""
    return {"status": "ok"}


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
app.include_router(reports_router)


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
