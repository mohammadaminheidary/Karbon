# Reorganization verification — 2026-10-29

This section records the full local workspace after reorganization, including
the pre-existing, uncommitted inventory/warehouse work. The reorganization commit
excludes those feature edits and the local handoff. Commit-snapshot validation is
recorded separately below; full-workspace counts must not be read as commit-only
test counts.

## File preservation and paths

A SHA-256 inventory of the original working tree was taken before moving files.
All 257 original project files (excluding installed Node dependencies and Python
caches) still exist at their mapped destinations. The pre-existing warehouse and
inventory edits are retained. HTML, JavaScript, source CSS, templates and visual
assets are byte-identical after relocation; generated Tailwind CSS was rebuilt.
The bank catalog and package lock are also unchanged.

The three files in the existing `~/.karbon` directory retain their original bytes
and names. No production database or encryption key was used for test mutations.
The bundled biometric models remain at their original paths and successfully
passed the application's checksums and OpenCV model loading.

## Checks performed

Commands below run from the repository root unless stated otherwise.

| Check | Result |
| --- | --- |
| Original Python suite before relocation | 113 tests, successful with 1 real-face test skipped |
| `python3 -m unittest discover -s backend/tests -v` | 109 tests, successful with the same 1 skip |
| `python3 -m unittest discover -s frontend/tests -v` | 10 tests passed |
| `npm --prefix frontend test` | 65 Node tests passed, matching the pre-migration result |
| `npm --prefix frontend run build` | Navigation and Tailwind build succeeded |
| `python3 frontend/scripts/build_navigation.py --check` | Passed; generated navigation is current and idempotent |
| Python compile checks | Passed for launcher, backend, build scripts, server and tests |
| Local backend module imports | 50 scanned application/package modules imported successfully with a temporary database |
| Frontend reference graph | HTML links/assets, CSS imports/fonts/backgrounds and all JS ES imports resolved; JS syntax passed |
| `npm --prefix frontend ls --depth=0` | Existing installed dependencies resolve; no new dependency added |
| Backend launchers | Absolute `backend/run.py` from a temporary working directory, and `python3 -m backend.run`, both started and stopped correctly |
| Root launcher | Absolute `start.py` from an unrelated working directory built assets and started both servers with a temporary database |
| HTTP and CORS | API health, login/dashboard/warehouse assets, fonts/logos and real CORS preflight passed |
| Shutdown/error cleanup | Ctrl+C, SIGTERM and unexpected frontend termination all cleaned up launcher-owned servers and API reload worker; ports were released |
| Static private-file protection | GET/HEAD denial for private paths passed; normal pages and camera modules remain accessible |
| `git diff --check` | Passed |

Local servers were tested outside the sandbox's loopback restriction with
permission granted by automatic review. All fixtures use disposable SQLite data.
The installed interpreter is Python 3.13 (`python3`); this environment has no
`python` command. The root entry point remains usable as `python start.py` on
installations where `python` names the required Python 3 interpreter.

## Existing browser scripts

Playwright from the bundled runtime and the installed Google Chrome were used.
Each script ran against a new fixture from `frontend/tests/serve_customers_fixture.py`,
with a temporary database, actual API communication/CORS and the same original
HTML/JS/CSS sources. Browser scripts were invoked by absolute path from `/tmp`.

| Browser script | Result |
| --- | --- |
| `data_fetching_browser.mjs` | Passed: pages/settings, request sharing, cache, mutation invalidation and refresh |
| `refresh_browser.mjs` | Passed: 14 refresh/error/recovery cases |
| `dashboard_browser.mjs` | Passed: totals, chart interactions, filters, responsive layout and refresh |
| `warehouse_browser.mjs` | Passed: settings persistence, active options, form, history and responsive layout |
| `purchase_transition_browser.mjs` | Passed: transition timing, layout, history, reduced motion and form retention |
| `navigation_browser.mjs` | Failed: an existing locator for the customer link matches both the navbar and a dashboard link |
| `startup_browser.mjs` | Failed: page-ready timeout in the rapid-navigation loop (line 234), following a connection reset |
| `face_attendance_browser.mjs` | Initial settings-readiness timeout; isolated rerun reached scan-spacing assertion at line 698 and failed identically to the original layout |

The original directory layout was reconstructed in `/tmp` from the unchanged
application sources, reversing the bank-catalog and fixture backend paths. Both
navigation and startup scripts failed at the same assertions in that layout.
The face browser script progressed further in that layout but failed its existing
scan-spacing assertion (`scanTimes[1] - scanTimes[0] >= 3000`, line 698).
The isolated rerun in the reorganized layout failed the same scan-spacing assertion at line 698. All three remaining browser failures were therefore reproduced in the original layout as well. These broader browser checks are not reported as passing. No application logic,
selectors or camera timing was changed to make them pass.

The real-photo registration/recognition test requires `KARBON_TEST_FACE_IMAGES`
and was skipped because no consenting three-angle test photos were supplied.
Actual webcam capture and biometric recognition of a real person were not tested;
model loading, service tests and synthetic-camera browser checks are separate.

## Commit-snapshot validation

The exact Git index was exported into a separate temporary directory, excluding
the existing inventory/warehouse feature and the untracked local handoff. All 13
relocated files that also contain those local feature edits were staged with
their original committed application content; the working files were not reset
or overwritten. Backend inventory routes/models and warehouse source/tests remain
local and uncommitted.

The reviewed commit contains 181 logical file changes: 164 relocations, 13
modifications and four additions. It includes frontend pages/assets/templates,
package files/build scripts/static server, split API/frontend test directories,
the bank catalog relocation, root launcher and related documentation/configuration.
The four new files are `frontend/tests/test_asset_paths.py`,
`frontend/tests/test_launcher.py`, `docs/project-layout.md` and this report.

The following checks were rerun against that exact staged snapshot:

| Check | Result |
| --- | --- |
| Backend Python suite | 107 tests: 106 passed, 1 real-photo test skipped |
| Frontend Python suite | All 10 tests passed, including the three real root-launcher lifecycle tests |
| Node suite | All 65 tests passed |
| Frontend build, Python compilation and navigation consistency | Passed |
| `data_fetching_browser.mjs` | Passed against a fresh database and real CORS/API requests |
| `dashboard_browser.mjs` | Passed against a separate fresh database |
| Staged-diff whitespace validation | Passed |
| Sensitive paths and credential scan of staged blobs | No secret, database, private key, environment file or biometric data was found; credential literals are isolated test fixtures |

The three previously failing broader browser scripts were not rerun for this
commit review; their original-layout comparison and failures remain documented
above. No change was made to their selectors or timing assertions.

The target remote was fetched before committing. Local `develop` and
`origin/develop` had identical heads, so no merge, rebase or history rewrite was
needed. The pre-existing proposal document is a byte-identical move of an already
tracked generic project document, rather than a newly introduced user artifact.
