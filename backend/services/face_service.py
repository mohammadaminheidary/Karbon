"""Local YuNet + SFace inference with encrypted multi-angle registration."""
import base64
import binascii
import hashlib
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from cryptography.fernet import InvalidToken
from sqlalchemy.dialects.sqlite import insert

from models.member_face import MemberFace, MemberFacePhoto
from security.face_templates import decrypt_template, encrypt_template

MODEL_VERSION = "sface-2021dec-v1"
MATCH_THRESHOLD = 0.55
MATCH_MARGIN = 0.08
REGISTRATION_ANGLES = ("front", "left", "right")
# Same normalized viewport as the fixed SVG guide (50, 49, 27, 36).
GUIDE_CENTER = (.50, .49)
GUIDE_RADII = (.27, .36)
# Detection boxes vary slightly with face shape, head tilt and webcam noise.
# This small viewport margin affects validation only; the visible oval is fixed.
GUIDE_FIT_MARGIN = .025
MODEL_DIR = Path(__file__).resolve().parents[1] / "face_models"
MODEL_HASHES = {
    "face_detection_yunet_2023mar.onnx": "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    "face_recognition_sface_2021dec.onnx": "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
}


class FaceError(Exception):
    def __init__(self, code, message, status=422, sample_index=None, box=None):
        self.code, self.message, self.status = code, message, status
        self.sample_index = sample_index
        self.box = box


class FaceEngine:
    def __init__(self):
        self.lock = threading.Lock()
        self.detector = self.recognizer = None

    def load(self):
        if self.detector is not None:
            return
        try:
            import cv2
            import numpy  # noqa: F401
            for name, expected in MODEL_HASHES.items():
                if hashlib.sha256((MODEL_DIR / name).read_bytes()).hexdigest() != expected:
                    raise ValueError("Invalid face model")
            detector = cv2.FaceDetectorYN.create(str(MODEL_DIR / "face_detection_yunet_2023mar.onnx"), "", (640, 480), 0.85, 0.3, 5000)
            recognizer = cv2.FaceRecognizerSF.create(str(MODEL_DIR / "face_recognition_sface_2021dec.onnx"), "")
            self.detector, self.recognizer = detector, recognizer
        except (ImportError, OSError, ValueError, AttributeError, RuntimeError) as error:
            raise FaceError("UNAVAILABLE", "تشخیص چهره آماده نیست. از ورود دستی استفاده کنید.", 503) from error

    @contextmanager
    def session(self):
        # OpenCV detector input sizes and DNN buffers are mutable, shared state.
        if not self.lock.acquire(blocking=False):
            raise FaceError("BUSY", "دوربین در حال پردازش است. کمی بعد دوباره تلاش کنید.", 429)
        try:
            self.load()
            yield
        finally:
            self.lock.release()

    def detect_frame(self, image, *, registration=False):
        import cv2
        import numpy as np
        from PIL import Image
        from io import BytesIO

        if not image.startswith("data:image/jpeg;base64,"):
            raise FaceError("INVALID_IMAGE", "تصویر دوربین معتبر نیست.")
        try:
            raw = base64.b64decode(image.split(",", 1)[1], validate=True)
            with Image.open(BytesIO(raw)) as header:
                width, height = header.size
                if header.format != "JPEG" or not (160 <= width <= 1280 and 160 <= height <= 1280):
                    raise ValueError("Image dimensions")
            frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                raise ValueError("Invalid JPEG")
        except (ValueError, OSError, binascii.Error) as error:
            raise FaceError("INVALID_IMAGE", "تصویر دوربین معتبر نیست.") from error
        height, width = frame.shape[:2]
        self.detector.setInputSize((width, height))
        _, faces = self.detector.detect(frame)
        if faces is None or len(faces) == 0:
            message = ("روبه‌روی دوربین بایستید و صورت را داخل بیضی ثابت قرار دهید؛ نور کافی باشد."
                       if registration else "روبه‌روی دوربین و در نور کافی قرار بگیرید.")
            raise FaceError("NO_FACE", message)
        if len(faces) != 1:
            raise FaceError("MULTIPLE_FACES", "فقط یک نفر مقابل دوربین باشد.")
        face = faces[0]
        box = preview_box(face, width, height)
        x, y, w, h = face[:4]
        try:
            if registration and (x < 0 or y < 0 or x + w > width or y + h > height):
                raise FaceError("INCOMPLETE", "تمام صورت در کادر دیده شود؛ کمی فاصله بگیرید و روبه‌رو بمانید.")
            if registration:
                registration_position(face, width, height)
            if h < 90 or w < 70 or h > height * .9 or x < 0 or y < 0 or x + w > width or y + h > height:
                raise FaceError("POSITION", "صورت را کامل و با فاصله مناسب داخل کادر قرار دهید.")
            gray = cv2.cvtColor(frame[int(y):int(y+h), int(x):int(x+w)], cv2.COLOR_BGR2GRAY)
            min_light, max_light, min_detail = (28, 242, 12) if registration else (35, 235, 20)
            if gray.mean() < min_light or gray.mean() > max_light or cv2.Laplacian(gray, cv2.CV_64F).var() < min_detail:
                raise FaceError("QUALITY", "تصویر تار یا نور نامناسب است؛ ثابت بمانید و نور را تنظیم کنید.")
        except FaceError as error:
            # Keep tracking a single face even when it is unsuitable to capture.
            error.box = box
            raise
        return frame, face

    def extract(self, images, *, poses=None):
        import numpy as np

        features = []
        for index, image in enumerate(images):
            try:
                frame, face = self.detect_frame(image, registration=poses is not None)
                if poses is not None:
                    poses.append(face_pose(face))
                aligned = self.recognizer.alignCrop(frame, face)
                feature = self.recognizer.feature(aligned).reshape(-1).astype("<f4")
                norm = np.linalg.norm(feature)
                if feature.shape != (128,) or not np.isfinite(feature).all() or norm <= 0:
                    raise FaceError("QUALITY", "ثبت چهره انجام نشد. دوباره تلاش کنید.")
                features.append(feature / norm)
            except FaceError as error:
                error.sample_index = index
                raise
        result = np.stack(features)
        comparisons = result @ result[0] if poses is not None else result @ result.T
        if float(np.min(comparisons)) < MATCH_THRESHOLD:
            index = int(np.argmin(comparisons)) if poses is not None else None
            raise FaceError("INCONSISTENT", "نمونه‌های چهره یکسان نیستند. یک نفر ثابت مقابل دوربین بماند.", sample_index=index)
        return result


engine = FaceEngine()


def face_pose(face):
    """Roll-normalized landmark proportions, independent of frame resolution.

    YuNet supplies eyes, nose and mouth corners. Only moderate turns with both
    eyes visible are accepted; profile/occluded faces remain a quality failure.
    Image-right is the participant's left in the unmirrored preview.
    """
    import numpy as np

    points = np.asarray(face[4:14], dtype=float).reshape(5, 2)
    eyes = sorted(points[:2], key=lambda point: point[0])
    horizontal = eyes[1] - eyes[0]
    span = np.linalg.norm(horizontal)
    if not np.isfinite(points).all() or span < 15:
        raise FaceError("POSITION", "هر دو چشم و صورت کامل داخل کادر دیده شوند.")
    horizontal /= span
    vertical = np.array([-horizontal[1], horizontal[0]])
    eye_center = (eyes[0] + eyes[1]) / 2
    mouth_center = (points[3] + points[4]) / 2
    depth = float((mouth_center - eye_center) @ vertical)
    if depth < span * .35:
        raise FaceError("POSITION", "صورت را صاف و کامل داخل کادر نگه دارید.")
    return (float((points[2] - eye_center) @ horizontal / span),
            float((points[2] - eye_center) @ vertical / depth))


def preview_box(face, width, height):
    """Map the detector box to the centered, unmirrored square video crop."""
    import math
    x, y, w, h = (float(value) for value in face[:4])
    if not all(math.isfinite(value) for value in (x, y, w, h)) or w <= 0 or h <= 0:
        raise FaceError("POSITION", "صورت را کامل داخل کادر قرار دهید.")
    side = min(width, height)
    return [(x - (width - side) / 2) / side,
            (y - (height - side) / 2) / side, w / side, h / side]


def registration_position(face, width, height):
    """Fit the detected face ellipse to the fixed guide with a small margin.

    YuNet boxes enclose a face; their corresponding ellipse approximates its
    outline. A little detector jitter or head tilt can cross the line without
    spoiling a usable image. The visible guide stays fixed across cameras.
    """
    import math
    box = preview_box(face, width, height)
    left, top, bw, bh = box
    gx, gy = GUIDE_CENTER
    rx, ry = (radius + GUIDE_FIT_MARGIN for radius in GUIDE_RADII)
    if bw > 2 * rx + 1e-6 or bh > 2 * ry + 1e-6:
        raise FaceError("TOO_CLOSE", "کمی از دوربین فاصله بگیرید تا تمام صورت داخل بیضی ثابت جا شود.")
    if bw < .23 or bh < .36 or face[2] < 70 or face[3] < 90:
        raise FaceError("TOO_FAR", "کمی نزدیک‌تر شوید تا صورت داخل بیضی واضح‌تر دیده شود.")
    cx, cy = left + bw / 2, top + bh / 2
    if abs(cx - gx) > .09 or abs(cy - gy) > .10:
        raise FaceError("OFF_CENTER", "صورت را کمی به مرکز بیضی بیاورید؛ لازم نیست دقیقاً روی خط‌ها قرار بگیرید.")
    # Check the outline, not just the center: a large shifted face can be
    # centered enough but still protrude beyond the guide. Box corners are not
    # facial contours and would unnecessarily reject correctly fitted faces.
    for index in range(64):
        angle = math.tau * index / 64
        x = cx + bw / 2 * math.cos(angle)
        y = cy + bh / 2 * math.sin(angle)
        if ((x - gx) / rx) ** 2 + ((y - gy) / ry) ** 2 > 1 + 1e-6:
            raise FaceError("OFF_CENTER", "تمام صورت داخل خط بیضی بماند؛ کمی به مرکز بیایید یا فاصله را بیشتر کنید.")
    return box


def validate_angle(pose, index, reference=None):
    if not 0 <= index < len(REGISTRATION_ANGLES):
        raise FaceError("INVALID_INPUT", "زاویه ثبت چهره معتبر نیست.")
    yaw, pitch = pose
    if index == 0:
        valid = abs(yaw) <= .22 and .22 <= pitch <= .95
    else:
        front_yaw, _ = reference
        if index == 1:
            valid = yaw - front_yaw >= .12 and yaw <= .72
        else:
            valid = yaw - front_yaw <= -.12 and yaw >= -.72
    if not valid:
        instructions = (
            "مستقیم روبه‌روی دوربین نگاه کنید.",
            "سر را کمی به چپ خود بچرخانید؛ هر دو چشم دیده شوند.",
            "سر را کمی به راست خود بچرخانید؛ هر دو چشم دیده شوند.",
        )
        raise FaceError("ANGLE", f"تصویر {index + 1} از ۳: {instructions[index]}", sample_index=index)


def validate_angles(poses):
    if not 1 <= len(poses) <= len(REGISTRATION_ANGLES):
        raise FaceError("INVALID_INPUT", "ثبت چهره شامل سه زاویه روبه‌رو، چپ و راست است.")
    for index, pose in enumerate(poses):
        validate_angle(pose, index, poses[0])


def registration_feedback(image, angle, reference=None):
    # Feedback only uses detection/landmarks; SFace runs on actual captures.
    with engine.session():
        box = None
        try:
            frame, face = engine.detect_frame(image, registration=True)
            box = preview_box(face, frame.shape[1], frame.shape[0])
            pose = face_pose(face)
            index = REGISTRATION_ANGLES.index(angle)
            if index and reference is None:
                raise FaceError("FRONT_REQUIRED", "ابتدا تصویر روبه‌رو را ثبت کنید.")
            validate_angle(pose, index, reference)
            return {"ready": True, "code": "READY", "message": "جای صورت و زاویه درست است؛ ثابت بمانید.",
                    "box": box, "pose": list(pose)}
        except FaceError as error:
            if error.code == "INVALID_IMAGE":
                raise
            return {"ready": False, "code": error.code, "message": error.message,
                    "box": box if box is not None else error.box}


def registration_features(images):
    poses = []
    features = engine.extract(images, poses=poses)
    validate_angles(poses)
    return features


def validate_registration(images):
    # Read-only step validation. Final registration repeats every check and
    # writes the photos and template together only after all three pass.
    with engine.session():
        registration_features(images)


def read_templates(db):
    import numpy as np
    templates = []
    for row in db.query(MemberFace).all():
        if row.model_version != MODEL_VERSION:
            raise FaceError("TEMPLATE_UNAVAILABLE", "اطلاعات چهره نیاز به ثبت مجدد دارد. از ورود دستی استفاده کنید.", 503)
        try:
            data = decrypt_template(row.member_id, row.encrypted_template)
            feature = np.frombuffer(data, dtype="<f4").reshape(-1, 128)
            # Existing four-angle templates keep their full matching coverage.
            if len(feature) not in (len(REGISTRATION_ANGLES), 4):
                raise ValueError("Invalid sample count")
            if not np.isfinite(feature).all() or not np.allclose(np.linalg.norm(feature, axis=1), 1, atol=0.001):
                raise ValueError("Invalid template")
        except (InvalidToken, ValueError, OSError) as error:
            # Fail closed; skipping corrupt entries could misidentify someone.
            raise FaceError("TEMPLATE_UNAVAILABLE", "اطلاعات چهره قابل خواندن نیست. از ورود دستی استفاده کنید.", 503) from error
        templates.append((row.member_id, feature))
    return templates


def register_face(db, member_id, images):
    if len(images) != len(REGISTRATION_ANGLES):
        raise FaceError("INVALID_INPUT", "ثبت چهره به سه تصویر معتبر از سه زاویه نیاز دارد.")
    with engine.session():
        features = registration_features(images)
        for other_id, template in read_templates(db):
            if other_id != member_id and float((features @ template.T).max()) >= MATCH_THRESHOLD:
                raise FaceError("ALREADY_ENROLLED", "این چهره برای عضو دیگری ثبت شده است.", 409)
        try:
            encrypted = encrypt_template(member_id, features.astype("<f4").tobytes())
            photos = [MemberFacePhoto(member_id=member_id, angle=angle,
                      encrypted_image=encrypt_template(member_id, b"photo:" + angle.encode() + b":" + image.encode("ascii")))
                      for angle, image in zip(REGISTRATION_ANGLES, images)]
        except (ValueError, OSError) as error:
            raise FaceError("STORAGE_UNAVAILABLE", "ذخیره امن چهره آماده نیست. دوباره تلاش کنید.", 503) from error
        now = datetime.now(timezone.utc)
        statement = insert(MemberFace).values(member_id=member_id, encrypted_template=encrypted, model_version=MODEL_VERSION, consented_at=now, updated_at=now)
        db.execute(statement.on_conflict_do_update(index_elements=[MemberFace.member_id], set_={"encrypted_template": encrypted, "model_version": MODEL_VERSION, "consented_at": now, "updated_at": now}))
        db.query(MemberFacePhoto).filter(MemberFacePhoto.member_id == member_id).delete()
        db.add_all(photos)
        db.commit()


def recognize_member(db, images):
    import numpy as np

    with engine.session():
        templates = read_templates(db)
        if not templates:
            raise FaceError("NO_ENROLLMENTS", "هنوز چهره‌ای ثبت نشده است. از ورود دستی استفاده کنید.", 409)
        features = engine.extract(images)
        # Each frame must independently choose the same member with a clear
        # margin. Aggregating first could hide one frame matching another face.
        scores = np.stack([(features @ template.T).max(axis=1) for _, template in templates])
        winners = scores.argmax(axis=0)
        winner = int(winners[0])
        best = scores[winner]
        other_scores = np.delete(scores, winner, axis=0)
        runner_up = other_scores.max(axis=0) if len(other_scores) else np.full(len(features), -1)
        if not np.all(winners == winner) or float(best.min()) < MATCH_THRESHOLD or float((best - runner_up).min()) < MATCH_MARGIN:
            raise FaceError("NO_MATCH", "چهره با اطمینان شناسایی نشد. عضو را برای ورود دستی انتخاب کنید.", 409)
        return templates[winner][0]
