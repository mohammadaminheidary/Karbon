"""Isolated attendance/biometrics API tests. Optional three-angle JPEGs in env.

KARBON_TEST_FACE_IMAGES=front.jpg,left.jpg,right.jpg python3 -m unittest discover -s tests -p test_face_attendance.py
No test writes to the normal application database; photos use disposable storage.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


class FaceAttendanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="karbon-face-tests-")
        cls.database = Path(cls.temp.name) / "test.db"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{cls.port}/api"
        cls.log = open(Path(cls.temp.name) / "server.log", "w+")
        env = dict(os.environ, KARBON_DATABASE_PATH=str(cls.database), KARBON_JWT_SECRET="isolated-face-tests-secret")
        # No production hooks: service fakes are used only in unit tests below.
        bootstrap = f'''
import app
from database import SessionLocal
from models.user import User
from security.password import hash_password
import uvicorn
with SessionLocal() as db:
    db.add(User(username="face-test", password_hash=hash_password("test-password")))
    db.commit()
uvicorn.run(app.app, host="127.0.0.1", port={cls.port}, log_level="warning")
'''
        cls.server = subprocess.Popen([sys.executable, "-c", bootstrap], cwd=ROOT / "backend", env=env, stdout=cls.log, stderr=cls.log)
        for _ in range(150):
            try:
                status, data, _ = cls.request("POST", "/login", {"username": "face-test", "password": "test-password"}, authenticated=False)
                if status == 200:
                    cls.token = data["token"]
                    return
            except OSError:
                pass
            if cls.server.poll() is not None:
                cls.log.seek(0)
                raise RuntimeError(cls.log.read())
            time.sleep(.05)
        raise RuntimeError("Face fixture did not start")

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def request(cls, method, path, body=None, authenticated=True, origin=None):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        if authenticated:
            headers["Authorization"] = f"Bearer {cls.token}"
        request = urllib.request.Request(cls.base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None, response.headers

    def member(self):
        status, member, _ = self.request("POST", "/members", {"first_name": "عضو", "last_name": "آزمایشی"})
        self.assertEqual(status, 201)
        self.addCleanup(lambda: self.request("DELETE", f'/members/{member["id"]}'))
        return member["id"]

    def test_authentication_and_no_biometric_error_echo(self):
        for method, path, body in [
            ("GET", "/faces/status", None), ("GET", "/faces/members", None),
            ("PUT", "/faces/members/1", {"images": ["x" * 64] * 3, "consent": True}),
            ("DELETE", "/faces/members/1", None), ("POST", "/faces/check-in", {"images": ["x" * 64] * 3}),
            ("POST", "/attendance/check-in", {"member_id": 1}),
        ]:
            self.assertEqual(self.request(method, path, body, authenticated=False)[0], 401)
        secret_input = "private-camera-frame-" * 5
        for payload in ({"images": [secret_input]}, {"images": [secret_input] * 3}, {"images": [secret_input] * 3, "consent": False}):
            status, data, headers = self.request("PUT", "/faces/members/1", payload)
            self.assertEqual(status, 422)
            self.assertNotIn(secret_input, json.dumps(data))
            self.assertEqual(headers["Cache-Control"], "no-store")

    def test_manual_check_in_is_atomic_and_preserves_time(self):
        member_id = self.member()
        with ThreadPoolExecutor(max_workers=8) as pool:
            replies = list(pool.map(lambda _: self.request("POST", "/attendance/check-in", {"member_id": member_id}), range(16)))
        self.assertTrue(all(reply[0] == 200 for reply in replies), replies)
        records = [reply[1]["attendance"] for reply in replies]
        self.assertEqual(len({row["id"] for row in records}), 1)
        self.assertEqual(sum(not reply[1]["already_checked_in"] for reply in replies), 1)
        self.assertEqual(len({row["recorded_time"] for row in records}), 1)
        time.sleep(1.05)
        repeated = self.request("POST", "/attendance/check-in", {"member_id": member_id})[1]
        self.assertEqual(repeated["attendance"], records[0])
        self.assertTrue(repeated["already_checked_in"])
        rows = self.request("GET", f"/attendance?member_id={member_id}")[1]
        self.assertEqual(len(rows), 1)
        today = next(member for member in self.request("GET", "/attendance/today")[1] if member["id"] == member_id)
        self.assertEqual(today["today_status"], "present")
        self.assertEqual(today["total_present"], 1)
        self.assertEqual(self.request("POST", "/attendance/check-in", {"member_id": 999999})[0], 404)
        for payload in ({"member_id": 0}, {"member_id": member_id, "date": "2020-01-01"}, {"member_id": member_id, "status": "absent"}):
            self.assertEqual(self.request("POST", "/attendance/check-in", payload)[0], 422)

    def test_check_in_upgrades_absent_and_keeps_history_apis(self):
        member_id = self.member()
        status, absent, _ = self.request("POST", "/attendance", {"member_id": member_id, "status": "absent"})
        self.assertEqual(status, 200)
        status, result, _ = self.request("POST", "/attendance/check-in", {"member_id": member_id})
        self.assertEqual(status, 200)
        self.assertEqual(result["attendance"]["id"], absent["id"])
        self.assertFalse(result["already_checked_in"])
        self.assertEqual(result["attendance"]["status"], "present")
        day = result["attendance"]["date"]
        details = self.request("GET", f"/attendance/date/{day}")[1]
        self.assertIn(member_id, [member["id"] for member in details["present"]])
        self.assertNotIn(member_id, [member["id"] for member in details["absent"]])
        self.assertEqual(self.request("GET", f"/attendance/calendar?start_date={day}&end_date={day}")[0], 200)
        self.assertEqual(self.request("PUT", f'/attendance/{absent["id"]}', {"status": "absent"})[0], 200)

    def test_invalid_images_limits_and_unavailable_enrollments(self):
        member_id = self.member()
        status, data, _ = self.request("GET", "/faces/status")
        self.assertEqual(status, 200)
        self.assertTrue(data["available"], data)
        payloads = [
            {"images": ["not-a-jpeg" * 10] * 3, "consent": True},
            {"images": ["data:image/jpeg;base64," + "!" * 100] * 3, "consent": True},
            {"images": ["data:image/jpeg;base64," + base64.b64encode(b"not-an-image" * 10).decode()] * 3, "consent": True},
        ]
        for payload in payloads:
            status, data, _ = self.request("PUT", f"/faces/members/{member_id}", payload)
            self.assertEqual(status, 422, data)
        self.assertEqual(self.request("POST", "/faces/check-in", {"images": ["not-a-jpeg" * 10] * 3})[0], 409)
        status, data, _ = self.request("PUT", f"/faces/members/{member_id}", {"images": ["A" * 510000] * 4, "consent": True})
        self.assertEqual(status, 413)
        self.assertEqual(self.request("GET", "/attendance")[1], [])

    def test_guided_validation_is_authenticated_private_and_never_saves_partial_images(self):
        payload = {"images": ["not-a-jpeg" * 10], "consent": True}
        self.assertEqual(self.request("POST", "/faces/validate", payload, authenticated=False)[0], 401)
        for count in range(1, 4):
            payload["images"] = ["not-a-jpeg" * 10] * count
            status, data, headers = self.request("POST", "/faces/validate", payload)
            self.assertEqual(status, 422)
            self.assertEqual(data["detail"]["code"], "INVALID_IMAGE")
            self.assertNotIn("not-a-jpeg", json.dumps(data))
            self.assertEqual(headers["Cache-Control"], "no-store")
        for consent in (None, False):
            payload = {"images": ["private-image" * 10]}
            if consent is not None:
                payload["consent"] = consent
            self.assertEqual(self.request("POST", "/faces/validate", payload)[0], 422)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM member_face_photos").fetchone()[0], 0)

    def test_registration_and_validation_enforce_three_angle_limit(self):
        member_id = self.member()
        for count in (0, 1, 2, 4):
            status, data, _ = self.request("PUT", f"/faces/members/{member_id}",
                                           {"images": ["not-a-jpeg" * 10] * count, "consent": True})
            self.assertEqual(status, 422)
            self.assertEqual(data["detail"]["code"], "INVALID_INPUT")
        status, data, _ = self.request("PUT", f"/faces/members/{member_id}",
                                       {"images": ["not-a-jpeg" * 10] * 3, "consent": True})
        self.assertEqual(status, 422)
        self.assertEqual(data["detail"]["code"], "INVALID_IMAGE")
        status, data, _ = self.request("POST", "/faces/validate",
                                       {"images": ["not-a-jpeg" * 10] * 4, "consent": True})
        self.assertEqual(status, 422)
        self.assertEqual(data["detail"]["code"], "INVALID_INPUT")

    def test_live_guide_requires_consent_and_never_echoes_or_stores_frames(self):
        import cv2
        import numpy as np
        image = "data:image/jpeg;base64," + base64.b64encode(cv2.imencode(".jpg", np.full((480, 640, 3), 127, dtype=np.uint8))[1]).decode()
        payload = {"image": image, "angle": "front", "consent": True}
        self.assertEqual(self.request("POST", "/faces/guide", payload, authenticated=False)[0], 401)
        status, data, headers = self.request("POST", "/faces/guide", payload)
        self.assertEqual(status, 200, data)
        self.assertFalse(data["ready"])
        self.assertEqual(data["code"], "NO_FACE")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn(image, json.dumps(data))
        for change in ({"consent": False}, {"angle": "unknown"}, {"angle": "up"}, {"reference": [float("nan"), .6]}, {"reference": [0, 10]}):
            status, data, _ = self.request("POST", "/faces/guide", {**payload, **change})
            self.assertEqual(status, 422)
            self.assertNotIn(image, json.dumps(data))
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM member_face_photos").fetchone()[0], 0)

    @unittest.skipUnless(os.getenv("KARBON_TEST_FACE_IMAGES"), "Set KARBON_TEST_FACE_IMAGES to front,left,right JPEG paths for real inference")
    def test_real_enrollment_recognition_encryption_deletion(self):
        import cv2
        import numpy as np
        images = [cv2.imread(path) for path in os.environ["KARBON_TEST_FACE_IMAGES"].split(",")]
        self.assertEqual(len(images), 3)
        def uri(frame):
            self.assertIsNotNone(frame)
            scale = min(1, 640 / max(frame.shape[:2]))
            frame = cv2.resize(frame, (round(frame.shape[1] * scale), round(frame.shape[0] * scale)))
            return "data:image/jpeg;base64," + base64.b64encode(cv2.imencode(".jpg", frame)[1]).decode()
        samples = [uri(frame) for frame in images]
        member_id, other_id = self.member(), self.member()
        status, data, _ = self.request("PUT", f"/faces/members/{member_id}", {"images": samples, "consent": True})
        self.assertEqual(status, 200, data)
        self.assertEqual(self.request("PUT", f"/faces/members/{other_id}", {"images": samples, "consent": True})[0], 409)
        member = next(row for row in self.request("GET", "/members")[1] if row["id"] == member_id)
        self.assertTrue(member["face_registered"])
        self.assertNotIn("encrypted_template", member)
        metadata = self.request("GET", "/faces/members")[1]
        self.assertEqual(set(metadata[0]), {"member_id", "updated_at"})
        with closing(sqlite3.connect(self.database)) as db:
            stored = db.execute("SELECT encrypted_template FROM member_faces WHERE member_id=?", (member_id,)).fetchone()[0]
            self.assertTrue(stored.startswith(b"gAAAA"))
            self.assertNotIn(b"JFIF", stored)
        self.assertEqual((Path(self.temp.name) / "face.key").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.request("PUT", f"/faces/members/{member_id}", {"images": samples, "consent": True})[0], 200)
        result = self.request("POST", "/faces/check-in", {"images": samples[:2]})
        self.assertEqual(result[0], 200, result[1])
        self.assertEqual(result[1]["member"]["id"], member_id)
        repeated = self.request("POST", "/faces/check-in", {"images": samples[:2]})[1]
        self.assertTrue(repeated["already_checked_in"])
        self.assertEqual(repeated["attendance"], result[1]["attendance"])
        blank = uri(np.full_like(images[0], 127))
        self.assertEqual(self.request("POST", "/faces/check-in", {"images": [blank] * 3})[1]["detail"]["code"], "NO_FACE")
        (Path(self.temp.name) / "face.key").rename(Path(self.temp.name) / "face.key.saved")
        self.assertEqual(self.request("POST", "/faces/check-in", {"images": samples[:2]})[0], 503)
        self.assertFalse((Path(self.temp.name) / "face.key").exists())
        self.assertEqual(self.request("POST", "/attendance/check-in", {"member_id": other_id})[0], 200)
        (Path(self.temp.name) / "face.key.saved").rename(Path(self.temp.name) / "face.key")
        self.assertEqual(self.request("DELETE", f"/faces/members/{member_id}")[0], 204)
        self.assertEqual(self.request("GET", "/faces/members")[1], [])
        member = next(row for row in self.request("GET", "/members")[1] if row["id"] == member_id)
        self.assertFalse(member["face_registered"])
        self.assertEqual(self.request("PUT", f"/faces/members/{other_id}", {"images": samples, "consent": True})[0], 200)
        self.assertEqual(self.request("DELETE", f"/members/{other_id}")[0], 204)
        self.assertEqual(self.request("GET", "/faces/members")[1], [])

    def test_z_rate_limit_returns_recoverable_error(self):
        results = [self.request("POST", "/faces/check-in", {"images": ["not-a-jpeg" * 10] * 3}, origin="http://127.0.0.1:5501") for _ in range(31)]
        self.assertEqual(results[-1][0], 429)
        self.assertTrue(1 <= int(results[-1][2]["Retry-After"]) <= 60)
        self.assertIn("Retry-After", results[-1][2]["Access-Control-Expose-Headers"])
        self.assertEqual(self.request("GET", "/faces/status")[0], 200)


if __name__ == "__main__":
    unittest.main()
