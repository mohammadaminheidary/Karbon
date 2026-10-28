# Member face registration and check-in

Install dependencies with `python3 -m pip install -r backend/requirements.txt`, then start normally with `python3 start.py`. YuNet and SFace run locally; their bundled models are checksum verified. No biometric data is sent to external services.

## Three-angle registration

In Settings → Members, choose **ثبت چهره**, obtain consent, select the consent checkbox, and start the camera. The existing circular preview guides three captures in order: front, a moderate turn to the participant's left, and a moderate turn to their right. Both eyes and the whole face must remain visible. The unmirrored preview means the participant's left points toward image-right.

The preview uses a fixed oval centered at 50% horizontally and 49% vertically, with radii of 27% and 36% of the circular viewport. Eye-position marks and head-direction arrows stay at those same positions. The guide remains visible with no detected face or stale feedback, so the user always sees where to position their face. Its position and size never follow detection results. Viewport resizing scales the camera and guide together without changing their relative geometry.

Authenticated, read-only `POST /api/faces/guide` supplies live bounding-box, pose, and quality feedback about twice per second using YuNet without SFace inference or database writes. Detection requests run serially and pause in hidden tabs. Capture requires sufficient face size and clarity, a roughly centered face fitting the fixed oval, and the requested angle. A 2.5% viewport margin around the oval tolerates small detector/face-shape variations without moving the visible guide. Center offsets up to 9% horizontally and 10% vertically are permitted, subject to outline fit. Faces must occupy at least 23% of the viewport width and 36% of its height, and retain the 70×90-pixel minimum used by recognition. All coordinates use the same centered square crop as the unmirrored `object-fit: cover` preview, across landscape and portrait webcams. Positioning feedback explains when to move closer, move back, or center within the oval.

Each angle is captured automatically after at least two fresh valid observations spanning 400 ms (normally one 450 ms polling interval). Small natural movement is allowed: box changes up to 5% of the viewport and landmark pose changes up to 0.10, measured against both the previous and first observation in the hold. Old/repeated observations, larger movement, unusable lighting, excessive blur, incomplete faces, multiple faces, and a wrong angle cannot unlock capture. A response older than 1.4 seconds cannot trigger capture. Registration accepts moderately softer/dimmer images (mean grayscale 28–242 and Laplacian variance at least 12); recognition retains its existing 35–235 and 20 thresholds. The exact inspected frame goes to `POST /api/faces/validate` with the previous images and consent for an independent quality, position, angle, and SFace identity check.

Valid photos immediately populate the three-step strip and advance the smooth circular progress ring through 30%, 50%, and 70%; it reaches 100% only after saving succeeds. The user only follows the next head-direction instruction; there are no capture, confirmation, review, or final-save buttons. Rejected candidates are discarded and the same angle continues waiting automatically. After the third valid photo, registration saves automatically. If final validation rejects a specific angle, that angle is automatically replaced while retaining the other valid photos. An inconsistent identity set starts fresh. Temporary request/save failures back off and retry without approval; unrecoverable storage, authorization, or duplicate-registration failures use the existing error/retry path.

All three poses must match the frontal identity. Side turns need a relative yaw change of at least 0.12. Pose proportions are heuristics, rather than calibrated 3D measurements; they should be evaluated with the actual participant population. Final validation derives the pose baseline from the photos, never the advisory reference supplied to guide feedback. Matching thresholds, identity consistency, full-face visibility, and atomic saving are unchanged.

Only after all three steps pass does `PUT /api/faces/members/{id}` repeat the full validation, reject duplicate identities, and atomically save three encrypted photos and three normalized embeddings. An incomplete or invalid replacement leaves the previous registration intact. **مدیریت چهره** allows replacement or deletion with the existing inline confirmation. Deleting a registration or member cascades to its photos.

The progress ring advances on camera readiness and accepted images, holds at measured milestones during inference, and reaches 100% only on confirmed persistence. The live, correctly oriented video remains visible during capture and processing. Reduced motion disables ring interpolation, guide motion, and orbit rotation.

## Persistent camera sessions

Opening **ثبت ورود** starts recognition after camera permission. Two independently captured frames must select the same member, each above cosine threshold `0.55` and runner-up margin `0.08`. Each frame compares against all stored angles, improving coverage without loading photos or averaging away a useful angle. Both three- and existing four-embedding registrations remain readable with all their stored matching angles. Re-registering replaces the template and photos with the new front/left/right set, including removal of the old chin photo.

The active camera has no session or permission-prompt deadline. Empty frames, unknown faces, positioning/quality problems, transient network errors, busy inference workers, and rate limits retry on the same stream. Requests run serially, at least 2.5 seconds apart, respecting `Retry-After`; repeated network failures back off up to 10 seconds. Hidden tabs keep the session and suspend new inference until visible. Recognition stops on success, explicit cancellation/manual entry, unrecoverable errors, component removal, or page navigation. Server writes retain the existing dismissal guard until their response settles. Individual HTTP and hardware-startup failures are bounded independently of the active session lifetime.

Recognition records today's attendance atomically using the same SQLite upsert as manual check-in. Repeated arrivals preserve the first check-in time. Unknown or ambiguous matches never write attendance. Manual search by name, phone, and ID, history, and corrections remain available in the existing UI.

## Camera compatibility

The frontend requests video only through `getUserMedia` on localhost or HTTPS. It uses ideal resolution constraints, supported facing-mode/frame-rate preferences, then relaxed constraints if needed. If the default or selected camera fails, it tries dynamically enumerated video inputs. No device ID or OS-specific camera index is built into the application. Device labels are refreshed after permission and on `devicechange`. Track termination triggers camera recovery; a failure leaves a clear retry/manual path. Device selection, permission denial, absent cameras, busy hardware, and playback failures release streams and event listeners. A late permission grant after close or switching is immediately stopped.

The responsive circular frame and concentric progress ring are unchanged. Snapshots use the actual video dimensions, preserve aspect ratio, and never mirror or rotate the image. A reusable canvas bounds browser allocations. Unsupported optional camera APIs are feature detected; no Permissions API or `FaceDetector` dependency is required.

## Storage and privacy

`member_faces` stores only encrypted SFace templates. A separate `member_face_photos` table stores the three encrypted registration JPEG data URLs by member and angle; matching never loads this table. The existing `create_all` startup adds this table without modifying old registrations. Recognition frames and rejected/unfinished registration frames remain transient. Photos are never exposed by member APIs, returned in errors, cached, or written to public files/browser storage.

Fernet ciphertext is authenticated and bound to the member ID; photo payloads include their angle and a photo namespace. The dedicated key defaults to `face.key` beside the configured SQLite database, created with permissions `0600`. Set `KARBON_FACE_KEY` or `KARBON_FACE_KEY_PATH` for managed deployments. All workers must share the same key. Back it up securely; losing it requires re-enrollment. Missing/corrupt keys and templates fail closed while manual attendance remains available. Request bodies are bounded at 2,010,000 bytes, each JPEG at 500,000 characters and 1280 pixels per dimension, with private validation errors, no-store responses, and separate per-user limits for guide feedback (180/minute) and capture/recognition (30/minute). Guide feedback never invalidates application data caches or publishes mutation events.

This attendance feature does not establish liveness; a photo/video can spoof it. Pose and recognition thresholds need evaluation with actual deployment cameras, lighting, and consenting participants.

## Verification

Tests use disposable databases and synthetic video tracks; they never open a physical webcam or modify normal records.

```sh
python3 -m unittest discover -s backend/tests -p 'test_*.py'
npm --prefix frontend test
python3 frontend/tests/serve_customers_fixture.py --backend-port 8012 --frontend-port 5512 --members 3
KARBON_TEST_URL=http://127.0.0.1:5512 KARBON_PLAYWRIGHT_PATH=/path/to/playwright node frontend/tests/face_attendance_browser.mjs
```

The browser suite covers fully automatic capture and saving without confirmation, fixed guide geometry despite changing face boxes, missing faces, and stale feedback, distance/centering/pose/blur/lighting feedback, motion and stale-frame rejection, all three guided steps, automatic replacement after a final quality error, save retry without recapturing valid photos, invalid angle/quality retries, idle scanning beyond the former deadline, background suspension/resume, retry/backoff, camera switching/hotplug, constrained resolutions, portrait frames, busy/missing/denied cameras, late grants, unmount cleanup, non-mirrored pixels, circular desktop/mobile layout, progress, consent withdrawal, manual attendance, focus, and deletion. Set `KARBON_TEST_BROWSER=firefox` or `webkit` when those Playwright engines are installed; Chromium uses the local Chrome binary by default.

Python tests cover fixed-oval alignment and outline containment across eight camera resolutions/aspect ratios, narrow/broad/long faces and several distances, small turns with different landmark proportions and head roll, moderate softness/lighting acceptance with excessive blur/dark/bright rejection, bounding boxes during invalid positioning and incomplete faces, circular crop coordinates across portrait/landscape/square inputs, distance and centering errors, guide feedback without embedding inference, consent/privacy, nearest-angle matching, legacy templates, unknown/ambiguous matches, encryption, atomic replacement/deletion, invalid images, privacy, authentication, contention, payload bounds, and concurrent attendance. To additionally exercise real inference and persistence with three consented JPEGs, supply paths in front,left,right order:

```sh
KARBON_TEST_FACE_IMAGES=/path/front.jpg,/path/left.jpg,/path/right.jpg python3 -m unittest discover -s backend/tests -p test_face_attendance.py
```

Physical device/OS permission behavior, real participant recognition accuracy across the three angles, and browser engines unavailable on the test machine require deployment-device verification.
