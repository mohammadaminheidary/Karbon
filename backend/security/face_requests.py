"""Bound biometric request bodies before JSON parsing; never cache responses."""
from starlette.responses import JSONResponse

MAX_FACE_BODY = 2_010_000


class FaceRequestMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/faces"):
            return await self.app(scope, receive, send)

        async def private_send(message):
            if message["type"] == "http.response.start":
                message["headers"] = [(key, value) for key, value in message.get("headers", []) if key.lower() != b"cache-control"]
                message["headers"].extend([(b"cache-control", b"no-store"), (b"pragma", b"no-cache")])
            await send(message)

        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            size += len(message.get("body", b""))
            if size > MAX_FACE_BODY:
                response = JSONResponse({"detail": {"code": "TOO_LARGE", "message": "حجم تصویر بیش از حد مجاز است."}}, status_code=413)
                return await response(scope, receive, private_send)
            chunks.append(message.get("body", b""))
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, bounded_receive, private_send)
