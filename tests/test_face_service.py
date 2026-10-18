"""Matching safety, encrypted template isolation, and camera frame rejection."""
import base64
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


class FaceServiceTests(unittest.TestCase):
    def setUp(self):
        import numpy as np
        from sqlalchemy import create_engine
        from sqlalchemy.orm import Session
        from database import Base
        from models.member import Member
        from models.member_face import MemberFace
        import services.face_service as service
        from cryptography.fernet import Fernet
        self.np, self.service, self.Face, self.Member = np, service, MemberFace, Member
        self.temp = tempfile.TemporaryDirectory(prefix="karbon-face-service-")
        self.env = patch.dict(os.environ, {"KARBON_FACE_KEY": Fernet.generate_key().decode()})
        self.env.start()
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.db.add_all([Member(first_name="A", last_name="Test"), Member(first_name="B", last_name="Test")])
        self.db.commit()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.env.stop)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)

    def vector(self, first, second=0, count=3):
        vector = self.np.zeros(128, dtype="<f4")
        vector[0], vector[1] = first, second
        vector /= self.np.linalg.norm(vector)
        return self.np.stack([vector] * count)

    def enroll(self, member_id, feature):
        with patch.object(self.service, "registration_features", return_value=feature):
            self.service.register_face(self.db, member_id, ["fixture"] * 3)

    def recognize(self, feature):
        with patch.object(self.service.engine, "extract", return_value=feature):
            return self.service.recognize_member(self.db, ["fixture"] * len(feature))

    def test_unknown_and_ambiguous_matches_never_return_member(self):
        self.enroll(1, self.vector(1))
        self.enroll(2, self.vector(0, 1))
        self.assertEqual(self.recognize(self.vector(1)), 1)
        self.assertEqual(self.recognize(self.vector(0, 1)), 2)
        for feature in (self.vector(-1, -1), self.vector(1, 1), self.vector(1, 0.95)):
            with self.assertRaises(self.service.FaceError) as raised:
                self.recognize(feature)
            self.assertEqual(raised.exception.code, "NO_MATCH")
        # One matching sample must not override two inconsistent identities.
        inconsistent = self.vector(1)
        inconsistent[2] = self.vector(0, 1)[0]
        with self.assertRaises(self.service.FaceError):
            self.recognize(inconsistent)
        ambiguous_frame = self.vector(1)
        ambiguous_frame[0] = self.vector(.7, .714)[0]
        with self.assertRaises(self.service.FaceError):
            self.recognize(ambiguous_frame)

    def test_ciphertext_is_member_bound_and_corruption_fails_closed(self):
        from security.face_templates import decrypt_template
        from cryptography.fernet import InvalidToken
        self.enroll(1, self.vector(1))
        row = self.db.get(self.Face, 1)
        with self.assertRaises(InvalidToken):
            decrypt_template(2, row.encrypted_template)
        row.encrypted_template = b"corrupt-template"
        self.db.commit()
        with self.assertRaises(self.service.FaceError) as raised:
            self.recognize(self.vector(1))
        self.assertEqual(raised.exception.code, "TEMPLATE_UNAVAILABLE")

    def test_duplicate_enrollment_does_not_replace_other_member(self):
        self.enroll(1, self.vector(1))
        previous = self.db.get(self.Face, 1).encrypted_template
        with self.assertRaises(self.service.FaceError) as raised:
            self.enroll(2, self.vector(1))
        self.assertEqual(raised.exception.code, "ALREADY_ENROLLED")
        self.assertEqual(self.db.get(self.Face, 1).encrypted_template, previous)
        self.assertIsNone(self.db.get(self.Face, 2))

    def test_three_photos_are_encrypted_replaced_and_deleted_with_registration(self):
        from models.member_face import MemberFacePhoto
        from security.face_templates import decrypt_template
        from cryptography.fernet import InvalidToken
        self.enroll(1, self.vector(1))
        rows = self.db.query(MemberFacePhoto).all()
        self.assertEqual({row.angle for row in rows}, set(self.service.REGISTRATION_ANGLES))
        self.assertEqual(len(rows), 3)
        for row in rows:
            self.assertNotIn(b"fixture", row.encrypted_image)
            self.assertEqual(decrypt_template(1, row.encrypted_image), b"photo:" + row.angle.encode() + b":fixture")
            with self.assertRaises(InvalidToken):
                decrypt_template(2, row.encrypted_image)
        # An existing fourth-angle photo disappears only on replacement.
        self.db.add(MemberFacePhoto(member_id=1, angle="up", encrypted_image=b"legacy-photo"))
        self.db.commit()
        self.assertEqual(self.db.query(MemberFacePhoto).count(), 4)
        self.enroll(1, self.vector(1))
        self.assertEqual({row.angle for row in self.db.query(MemberFacePhoto)}, {"front", "left", "right"})
        previous = self.db.get(self.Face, 1).encrypted_template
        with patch.object(self.service, "registration_features", side_effect=self.service.FaceError("ANGLE", "wrong third angle")):
            with self.assertRaises(self.service.FaceError):
                self.service.register_face(self.db, 1, ["replacement"] * 3)
        self.assertEqual(self.db.get(self.Face, 1).encrypted_template, previous)
        self.assertEqual(self.db.query(MemberFacePhoto).count(), 3)
        # The real application enables this on every SQLite connection.
        from sqlalchemy import text
        self.db.execute(text("PRAGMA foreign_keys=ON"))
        self.db.query(self.Face).filter(self.Face.member_id == 1).delete()
        self.db.commit()
        self.assertEqual(self.db.query(MemberFacePhoto).count(), 0)

    def test_existing_four_sample_templates_and_new_three_angles_remain_recognizable(self):
        from security.face_templates import encrypt_template
        from datetime import datetime, timezone
        legacy = self.np.zeros((4, 128), dtype="<f4")
        legacy[:, 0] = .76
        for index in range(4):
            legacy[index, index + 1] = (1 - .76 ** 2) ** .5
        self.db.add(self.Face(member_id=1, encrypted_template=encrypt_template(1, legacy.tobytes()),
                              model_version=self.service.MODEL_VERSION, consented_at=datetime.now(timezone.utc)))
        self.db.commit()
        fourth_probe = self.np.zeros(128, dtype="<f4")
        fourth_probe[0], fourth_probe[4] = .40, (1 - .40 ** 2) ** .5
        self.assertEqual(self.recognize(self.np.stack([fourth_probe] * 2)), 1)
        # Each recognition angle matches its nearest enrollment sample, even
        # when the frontal sample alone falls below the recognition threshold.
        angles = self.np.zeros((3, 128), dtype="<f4")
        angles[:, 0] = .76
        for index in range(3):
            angles[index, index + 1] = (1 - .76 ** 2) ** .5
        self.enroll(1, angles)
        for index in range(3):
            probe = angles[index].copy()
            probe[0] = .40
            probe[index + 1] = (1 - .40 ** 2) ** .5
            self.assertEqual(self.recognize(self.np.stack([probe] * 2)), 1)

    def test_landmark_validation_accepts_all_three_angles_and_rejects_duplicates(self):
        np = self.np
        def face(yaw, pitch, roll=0):
            points = np.array([[200, 150], [300, 150], [250 + yaw * 100, 150 + pitch * 100], [220, 250], [280, 250]], dtype=float)
            rotation = np.array([[np.cos(roll), -np.sin(roll)], [np.sin(roll), np.cos(roll)]])
            points = (points - [250, 200]) @ rotation.T + [250, 200]
            return np.array([150, 100, 200, 220, *points.flatten(), .99])
        for roll in (0, .12, -.12):
            poses = [self.service.face_pose(face(yaw, pitch, roll)) for yaw, pitch in ((0, .6), (.25, .6), (-.25, .6))]
            for count in range(1, 4):
                self.service.validate_angles(poses[:count])
            for index in range(1, 3):
                invalid = poses.copy()
                invalid[index] = poses[0]
                with self.assertRaises(self.service.FaceError) as raised:
                    self.service.validate_angles(invalid)
                self.assertEqual(raised.exception.code, "ANGLE")
            with self.assertRaises(self.service.FaceError):
                self.service.validate_angles([poses[2]])
        with self.assertRaises(self.service.FaceError):
            self.service.face_pose(np.array([0] * 15))

    def test_validation_rechecks_quality_identity_and_angles_without_writes(self):
        def extract(images, *, poses):
            poses.extend([(0, .6), (.25, .6), (-.25, .6)][:len(images)])
            return self.vector(1, count=len(images))
        with patch.object(self.service.engine, "extract", side_effect=extract):
            for count in range(1, 4):
                self.service.validate_registration(["fixture"] * count)
                self.assertEqual(self.db.query(self.Face).count(), 0)
            self.service.register_face(self.db, 1, ["fixture"] * 3)
        with patch.object(self.service.engine, "extract", side_effect=self.service.FaceError("QUALITY", "blurred third photo")):
            with self.assertRaises(self.service.FaceError):
                self.service.register_face(self.db, 2, ["fixture"] * 3)
        self.assertIsNone(self.db.get(self.Face, 2))

    def test_registration_requires_exactly_three_images_and_rejects_removed_step(self):
        for count in (0, 1, 2, 4):
            with self.subTest(count=count), self.assertRaises(self.service.FaceError) as raised:
                self.service.register_face(self.db, 1, ["fixture"] * count)
            self.assertEqual(raised.exception.code, "INVALID_INPUT")
        with self.assertRaises(self.service.FaceError) as raised:
            self.service.validate_angles([(0, .6), (.25, .6), (-.25, .6), (0, .4)])
        self.assertEqual(raised.exception.code, "INVALID_INPUT")
        with self.assertRaises(self.service.FaceError) as raised:
            self.service.validate_angle((0, .4), 3, (0, .6))
        self.assertEqual(raised.exception.code, "INVALID_INPUT")
        self.assertEqual(self.db.query(self.Face).count(), 0)

    def test_small_turns_across_face_proportions_and_roll(self):
        np = self.np
        for span, depth in ((70, 80), (100, 100), (120, 150)):
            for front_pitch in (.24, .34, .6, .92):
                for front_yaw in (-.18, .18):
                    for roll in (-.25, 0, .25):
                        def pose(yaw, pitch):
                            points = np.array([[-span/2, 0], [span/2, 0],
                                               [yaw*span, pitch*depth],
                                               [-span*.3, depth], [span*.3, depth]])
                            rotation = np.array([[np.cos(roll), -np.sin(roll)],
                                                 [np.sin(roll), np.cos(roll)]])
                            points = points @ rotation.T + [320, 200]
                            return self.service.face_pose(np.array([220, 100, 200, 260, *points.flatten(), .99]))
                        with self.subTest(span=span, depth=depth, pitch=front_pitch, yaw=front_yaw, roll=roll):
                            reference = pose(front_yaw, front_pitch)
                            poses = [reference, pose(front_yaw+.14, front_pitch),
                                     pose(front_yaw-.14, front_pitch)]
                            self.service.validate_angles(poses)
                            for index in (1, 2):
                                with self.assertRaises(self.service.FaceError):
                                    self.service.validate_angle(reference, index, reference)

    def test_registration_accepts_moderate_softness_and_lighting_but_keeps_quality_floor(self):
        import cv2
        from unittest.mock import Mock
        np = self.np
        face = np.array([[220, 100, 200, 260, 270, 150, 370, 150,
                          320, 210, 290, 250, 350, 250, .99]], dtype=np.float32)
        detector = Mock()
        detector.detect.return_value = (None, face)
        def image(brightness, detail):
            gray = np.clip(np.random.default_rng(44).normal(brightness, detail, (480,640)), 0, 255).astype(np.uint8)
            return "data:image/jpeg;base64," + base64.b64encode(cv2.imencode(".jpg", gray, [cv2.IMWRITE_JPEG_QUALITY, 100])[1]).decode()
        with self.service.engine.session(), patch.object(self.service.engine, "detector", detector):
            for brightness, detail in ((120, .8), (32, 2), (238, 2)):
                with self.subTest(brightness=brightness, detail=detail):
                    candidate = image(brightness, detail)
                    self.service.engine.detect_frame(candidate, registration=True)
                    # Relaxing enrollment does not alter recognition checks.
                    with self.assertRaises(self.service.FaceError) as raised:
                        self.service.engine.detect_frame(candidate)
                    self.assertEqual(raised.exception.code, "QUALITY")
            for brightness, detail in ((24, 2), (247, 2), (120, .2), (120, 0)):
                with self.subTest(brightness=brightness, detail=detail):
                    with self.assertRaises(self.service.FaceError) as raised:
                        self.service.engine.detect_frame(image(brightness, detail), registration=True)
                    self.assertEqual(raised.exception.code, "QUALITY")

    def test_decoded_registration_frames_pass_all_angles_and_reject_changed_identity(self):
        import cv2
        from unittest.mock import Mock
        np = self.np
        frame = np.random.default_rng(8).integers(30, 225, (480, 640, 3), dtype=np.uint8)
        image = "data:image/jpeg;base64," + base64.b64encode(cv2.imencode(".jpg", frame)[1]).decode()
        faces = [np.array([[220, 100, 200, 220, 270, 150, 370, 150,
                            320 + yaw * 100, 150 + pitch * 100, 290, 250, 350, 250, .99]], dtype=np.float32)
                 for yaw, pitch in ((.18, .6), (.32, .6), (.04, .6))]
        detector, recognizer = Mock(), Mock()
        detector.detect.side_effect = [(None, face) for face in faces]
        recognizer.feature.return_value = self.vector(1)[0].reshape(1, 128)
        with self.service.engine.session(), patch.object(self.service.engine, "detector", detector), patch.object(self.service.engine, "recognizer", recognizer):
            features = self.service.registration_features([image] * 3)
            self.assertEqual(features.shape, (3, 128))
            detector.detect.side_effect = [(None, face) for face in faces]
            recognizer.feature.side_effect = [self.vector(1)[0]] * 2 + [self.vector(0, 1)[0]]
            with self.assertRaises(self.service.FaceError) as raised:
                self.service.registration_features([image] * 3)
            self.assertEqual(raised.exception.code, "INCONSISTENT")

    def test_model_unavailability_and_busy_worker_are_recoverable(self):
        engine = self.service.FaceEngine()
        with tempfile.TemporaryDirectory() as empty, patch.object(self.service, "MODEL_DIR", Path(empty)):
            with self.assertRaises(self.service.FaceError) as raised:
                with engine.session():
                    pass
            self.assertEqual(raised.exception.status, 503)
        engine.lock.acquire()
        try:
            with self.assertRaises(self.service.FaceError) as raised:
                with engine.session():
                    pass
            self.assertEqual(raised.exception.status, 429)
        finally:
            engine.lock.release()

    def test_circle_position_matches_landscape_portrait_and_square_previews(self):
        for width, height in ((640, 480), (480, 640), (640, 360), (360, 640), (400, 400)):
            side = min(width, height)
            box = [.29, .20, .42, .58]
            face = [box[0] * side + (width - side) / 2,
                    box[1] * side + (height - side) / 2, box[2] * side, box[3] * side]
            self.np.testing.assert_allclose(self.service.registration_position(face, width, height), box)
            for replacement, code in (([.29, .2, .7, .8], "TOO_CLOSE"),
                                      ([.4, .3, .2, .3], "TOO_FAR"),
                                      ([.0, .2, .42, .58], "OFF_CENTER")):
                candidate = [replacement[0] * side + (width - side) / 2,
                             replacement[1] * side + (height - side) / 2,
                             replacement[2] * side, replacement[3] * side]
                with self.assertRaises(self.service.FaceError) as raised:
                    self.service.registration_position(candidate, width, height)
                self.assertEqual(raised.exception.code, code)

    def test_live_feedback_checks_all_angles_and_quality_without_embedding_inference(self):
        import cv2
        from unittest.mock import Mock
        np = self.np
        frame = np.random.default_rng(9).integers(30, 225, (480, 640, 3), dtype=np.uint8)
        image = "data:image/jpeg;base64," + base64.b64encode(cv2.imencode(".jpg", frame)[1]).decode()
        detector, recognizer = Mock(), Mock()
        def face(yaw=0, pitch=.6):
            return np.array([[220, 100, 200, 260, 270, 150, 370, 150,
                             320 + yaw * 100, 150 + pitch * 100, 290, 250, 350, 250, .99]], dtype=np.float32)
        with self.service.engine.session():
            pass
        with patch.object(self.service.engine, "detector", detector), patch.object(self.service.engine, "recognizer", recognizer):
            for angle, yaw, pitch in (("front", 0, .6), ("left", .25, .6), ("right", -.25, .6)):
                detector.detect.return_value = (None, face(yaw, pitch))
                result = self.service.registration_feedback(image, angle, (0, .6))
                self.assertTrue(result["ready"], result)
                self.np.testing.assert_allclose(result["pose"], [yaw, pitch])
                self.assertEqual(len(result["box"]), 4)
                if angle != "front":
                    self.assertEqual(self.service.registration_feedback(image, angle)["code"], "FRONT_REQUIRED")
            detector.detect.return_value = (None, face())
            self.assertEqual(self.service.registration_feedback(image, "left", (0, .6))["code"], "ANGLE")
            for bounds, code in (([100, 40, 400, 400], "TOO_CLOSE"), ([280, 160, 80, 100], "TOO_FAR"), ([80, 100, 200, 260], "OFF_CENTER")):
                candidate = face()
                candidate[0, :4] = bounds
                detector.detect.return_value = (None, candidate)
                self.assertEqual(self.service.registration_feedback(image, "front")["code"], code)
            detector.detect.return_value = (None, face())
            blur = "data:image/jpeg;base64," + base64.b64encode(cv2.imencode(".jpg", np.full_like(frame, 127))[1]).decode()
            self.assertEqual(self.service.registration_feedback(blur, "front")["code"], "QUALITY")
            detector.detect.return_value = (None, None)
            self.assertEqual(self.service.registration_feedback(image, "front")["code"], "NO_FACE")
            detector.detect.return_value = (None, np.repeat(face(), 2, axis=0))
            self.assertEqual(self.service.registration_feedback(image, "front")["code"], "MULTIPLE_FACES")
            recognizer.feature.assert_not_called()

    def test_multiple_faces_position_quality_and_large_jpegs_are_rejected(self):
        import cv2
        np = self.np
        frame = np.random.default_rng(7).integers(30, 225, (480, 640, 3), dtype=np.uint8)
        def uri(image):
            return "data:image/jpeg;base64," + base64.b64encode(cv2.imencode(".jpg", image)[1]).decode()
        samples = [uri(frame)] * 3
        engine = self.service.engine
        with engine.session():
            cases = [
                (None, "NO_FACE"),
                (np.ones((2, 15), dtype=np.float32), "MULTIPLE_FACES"),
                (np.array([[10, 10, 40, 40] + [0] * 11], dtype=np.float32), "POSITION"),
            ]
            # Mock detector output while retaining the actual decoder and checks.
            from unittest.mock import Mock
            detector = Mock()
            with patch.object(engine, "detector", detector):
                for faces, expected in cases:
                    detector.detect.return_value = (None, faces)
                    with self.assertRaises(self.service.FaceError) as raised:
                        engine.extract(samples)
                    self.assertEqual(raised.exception.code, expected)
                detector.detect.return_value = (None, np.array([[100, 100, 150, 180] + [0] * 11], dtype=np.float32))
                with self.assertRaises(self.service.FaceError) as raised:
                    engine.extract([uri(np.zeros_like(frame))] * 3)
                self.assertEqual(raised.exception.code, "QUALITY")
            oversized = uri(np.full((1300, 160, 3), 127, dtype=np.uint8))
            with self.assertRaises(self.service.FaceError) as raised:
                engine.extract([oversized] * 3)
            self.assertEqual(raised.exception.code, "INVALID_IMAGE")

    def test_feedback_tracks_different_faces_and_preserves_boxes_during_rejection(self):
        import cv2
        from unittest.mock import Mock
        np = self.np
        frame = np.random.default_rng(10).integers(30, 225, (480, 640, 3), dtype=np.uint8)
        def uri(image):
            return "data:image/jpeg;base64," + base64.b64encode(cv2.imencode(".jpg", image)[1]).decode()
        base = np.array([220, 100, 200, 260, 270, 150, 370, 150, 320, 210, 290, 250, 350, 250, .99], dtype=np.float32)
        detector = Mock()
        with self.service.engine.session():
            pass
        with patch.object(self.service.engine, "detector", detector):
            for scale in (.8, 1, 1.2):
                for dx in (-24, 0, 24):
                    face = base.copy()
                    face[:2] = (face[:2] - [320, 230]) * scale + [320 + dx, 230]
                    face[2:4] *= scale
                    face[4:14] = ((face[4:14].reshape(5, 2) - [320, 230]) * scale + [320 + dx, 230]).flatten()
                    detector.detect.return_value = (None, face.reshape(1, -1))
                    result = self.service.registration_feedback(uri(frame), "front")
                    # Even the relaxed margin rejects a large shifted face
                    # that extends too far outside the fixed oval.
                    self.assertEqual(result["ready"], not (scale == 1.2 and dx != 0), result)
                    if not result["ready"]:
                        self.assertEqual(result["code"], "OFF_CENTER")
                    np.testing.assert_allclose(result["box"], self.service.preview_box(face, 640, 480))
            detector.detect.return_value = (None, base.reshape(1, -1))
            for brightness in (0, 127, 255):
                result = self.service.registration_feedback(uri(np.full_like(frame, brightness)), "front")
                self.assertFalse(result["ready"])
                self.assertEqual(result["code"], "QUALITY")
                np.testing.assert_allclose(result["box"], self.service.preview_box(base, 640, 480))
            clipped = base.copy()
            clipped[0] = -10
            detector.detect.return_value = (None, clipped.reshape(1, -1))
            result = self.service.registration_feedback(uri(frame), "front")
            self.assertEqual(result["code"], "INCOMPLETE")
            self.assertLess(result["box"][0], 0)
            detector.detect.return_value = (None, None)
            self.assertIsNone(self.service.registration_feedback(uri(frame), "front")["box"])

            detector.detect.return_value = (None, np.repeat(base.reshape(1, -1), 2, axis=0))
            self.assertIsNone(self.service.registration_feedback(uri(frame), "front")["box"])

    def test_fixed_oval_fit_across_face_sizes_distances_and_camera_aspect_ratios(self):
        # Normalized face ellipses, independent of camera resolution or UI size.
        cases = [
            ([.29, .20, .42, .58], None),
            ([.34, .25, .32, .48], None),
            ([.24, .14, .52, .70], None),
            ([.38, .20, .24, .58], None),  # narrow face
            ([.24, .29, .52, .40], None),  # broad face
            ([.34, .13, .32, .72], None),  # long face
            ([.38, .30, .24, .38], None),  # smaller/more distant
            ([.46, .30, .24, .38], None),  # reasonable horizontal shift
            ([.34, .33, .32, .48], None),  # chin lift / vertical shift
            ([.40, .35, .20, .28], "TOO_FAR"),
            ([.20, .10, .60, .78], "TOO_CLOSE"),
            ([.10, .20, .42, .58], "OFF_CENTER"),
            ([.28, .15, .50, .68], None),  # slight guide overlap is fine
            ([.32, .15, .50, .68], "OFF_CENTER"),
            ([.25, .20, .50, .68], "OFF_CENTER"),
        ]
        for width, height in ((640,480), (480,640), (1280,720), (720,1280), (1920,1080), (640,360), (360,640), (400,400)):
            side = min(width, height)
            for box, expected in cases:
                face = [box[0] * side + (width-side)/2, box[1] * side + (height-side)/2,
                        box[2] * side, box[3] * side]
                with self.subTest(camera=(width,height), box=box):
                    if expected is None:
                        self.np.testing.assert_allclose(self.service.registration_position(face, width, height), box)
                    else:
                        with self.assertRaises(self.service.FaceError) as raised:
                            self.service.registration_position(face, width, height)
                        self.assertEqual(raised.exception.code, expected)


if __name__ == "__main__":
    unittest.main()
