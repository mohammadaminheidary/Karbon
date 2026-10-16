"""Daily task API integration tests against an isolated SQLite database."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]


class TasksIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="karbon-tasks-")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{cls.port}/api"
        cls.log = open(Path(cls.temp.name) / "server.log", "w+")
        env = dict(os.environ, KARBON_DATABASE_PATH=str(Path(cls.temp.name) / "test.db"), KARBON_JWT_SECRET="isolated-tasks-test-secret")
        bootstrap = f'''
import app
from database import SessionLocal
from models.user import User
from security.password import hash_password
import uvicorn
with SessionLocal() as db:
    db.add(User(username="tasks-test", password_hash=hash_password("test-password")))
    db.commit()
uvicorn.run(app.app, host="127.0.0.1", port={cls.port}, log_level="warning")
'''
        cls.server = subprocess.Popen([sys.executable, "-c", bootstrap], cwd=ROOT / "backend", env=env, stdout=cls.log, stderr=cls.log)
        for _ in range(100):
            try:
                code, data = cls.request("POST", "/login", {"username": "tasks-test", "password": "test-password"}, authenticated=False)
                if code == 200:
                    cls.token = data["token"]
                    return
            except OSError:
                pass
            if cls.server.poll() is not None:
                cls.log.seek(0)
                raise RuntimeError(cls.log.read())
            time.sleep(0.05)
        raise RuntimeError("Task test server did not start")

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def request(cls, method, path, body=None, authenticated=True):
        headers = {"Content-Type": "application/json"}
        if authenticated:
            headers["Authorization"] = f"Bearer {cls.token}"
        request = urllib.request.Request(cls.base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None

    def test_jalali_edit_and_delete_persist(self):
        payload = {"date": "۱۴۰۵/۰۷/۲۴", "title": "کار شمسی", "description": "خط اول\n" + "شرح کامل " * 300}
        code, task = self.request("POST", "/tasks", payload)
        self.assertEqual(code, 201, task)
        self.assertEqual(task["date"], "2026-10-16")
        task_id = task["id"]
        self.assertEqual(self.request("PUT", f"/tasks/{task_id}/status", {"status": "completed"})[0], 200)
        changes = {**payload, "date": "1405/08/01", "title": "عنوان ویرایش شده"}
        code, updated = self.request("PUT", f"/tasks/{task_id}", changes)
        self.assertEqual(code, 200, updated)
        self.assertEqual(updated["date"], "2026-10-23")
        self.assertEqual(updated["title"], changes["title"])
        self.assertEqual(updated["description"], payload["description"].strip())
        self.assertEqual(updated["status"], "completed", "editing must preserve the dragged status")
        stored = next(row for row in self.request("GET", "/tasks")[1] if row["id"] == task_id)
        self.assertEqual(stored, updated)
        self.assertEqual(self.request("DELETE", f"/tasks/{task_id}")[0], 204)
        self.assertFalse(any(row["id"] == task_id for row in self.request("GET", "/tasks")[1]))
        self.assertEqual(self.request("DELETE", f"/tasks/{task_id}")[0], 404)
        self.assertEqual(self.request("PUT", f"/tasks/{task_id}", changes)[0], 404)

    def test_invalid_jalali_edit_keeps_saved_task(self):
        payload = {"date": "1405/07/24", "title": "معتبر", "description": "بدون تغییر"}
        code, task = self.request("POST", "/tasks", payload)
        self.assertEqual(code, 201, task)
        for date in ("1405/12/30", "1405/07/31", "1405/13/01"):
            self.assertEqual(self.request("PUT", f'/tasks/{task["id"]}', {**payload, "date": date})[0], 422)
        self.assertEqual(self.request("PUT", f'/tasks/{task["id"]}', {**payload, "title": "  "})[0], 422)
        stored = next(row for row in self.request("GET", "/tasks")[1] if row["id"] == task["id"])
        self.assertEqual(stored, task)

    def test_create_status_transitions_and_persistence(self):
        payload = {"date": "2026-10-16", "title": "  کار روزانه  ", "description": "  توضیحات\nخط دوم  "}
        code, task = self.request("POST", "/tasks", payload)
        self.assertEqual(code, 201, task)
        self.assertEqual(task["title"], "کار روزانه")
        self.assertEqual(task["description"], "توضیحات\nخط دوم")
        self.assertEqual(task["status"], "todo")
        for status in ("in_progress", "completed", "todo", "completed"):
            code, updated = self.request("PUT", f'/tasks/{task["id"]}/status', {"status": status})
            self.assertEqual(code, 200, updated)
            self.assertEqual(updated["status"], status)
            self.assertEqual(updated["date"], payload["date"])
        code, tasks = self.request("GET", "/tasks")
        self.assertEqual(code, 200)
        stored = next(item for item in tasks if item["id"] == task["id"])
        self.assertEqual(stored["status"], "completed")
        self.assertEqual(stored["description"], task["description"])

    def test_invalid_task_is_not_saved(self):
        before = len(self.request("GET", "/tasks")[1])
        base = {"date": "2026-10-16", "title": "Task"}
        for changes in ({"title": "   "}, {"title": "x" * 201}, {"description": "x" * 5001}, {"date": "2026-02-30"}, {"date": ""}, {"status": "completed"}):
            self.assertEqual(self.request("POST", "/tasks", {**base, **changes})[0], 422)
        self.assertEqual(len(self.request("GET", "/tasks")[1]), before)

    def test_invalid_status_and_missing_task(self):
        self.assertEqual(self.request("PUT", "/tasks/999999/status", {"status": "completed"})[0], 404)
        self.assertEqual(self.request("PUT", "/tasks/0/status", {"status": "todo"})[0], 422)
        self.assertEqual(self.request("PUT", "/tasks/1/status", {"status": "unknown"})[0], 422)

    def test_authentication_required(self):
        for method, path, body in (("GET", "/tasks", None), ("POST", "/tasks", {"date": "2026-10-16", "title": "Task"}), ("PUT", "/tasks/1/status", {"status": "completed"}), ("PUT", "/tasks/1", {"date": "1405/07/24", "title": "Task"}), ("DELETE", "/tasks/1", None)):
            self.assertEqual(self.request(method, path, body, authenticated=False)[0], 401)


if __name__ == "__main__":
    unittest.main()
