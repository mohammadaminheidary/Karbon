# Server connection loss

Karbon uses native document navigation, `protectPage()` for session validation,
`apiFetch()` for shared/cached reads, and `KarbonAppearance` for Settings themes.
Previously, network failures were handled separately by API clients, while a
failed authentication check required a page reload. There was no liveness endpoint
or shared connection monitor.

## Detection and recovery

- `backend/app.py` exposes `GET /api/health`, returning `{"status":"ok"}` without
  authentication, database queries, or session work. The existing privacy middleware
  sets `Cache-Control: no-store`. All protected endpoints retain their auth rules.
- `connection.js` supplies a shared `connectionFetch()` to `api-cache.js` and the
  uncached security, logout, face, and report clients. It does not patch global fetch
  or replace the API cache. Production's existing `KARBON_API_BASE_URL` rewrite also
  configures the health URL.
- A rejected network request, a 15-second request timeout, or HTTP 502/503/504
  initiates a separate, deduplicated health check. Face requests retain their
  caller's timeout (20 seconds by default); reports allow two minutes for export
  generation. The outage screen only appears
  when that health check fails (including a non-OK response, invalid health payload,
  or its five-second deadline). Thus route-specific errors cannot alone take over
  the application. Ordinary 4xx/500 responses retain their existing behavior; 401
  continues through normal authentication handling.
- Every document, including login and Settings, starts the same monitor through
  `startPage()`. A one-second initial check is skipped if API traffic has already
  established reachability. Thereafter, visible idle pages check after 30 seconds
  without API contact. Browser online/offline and foreground/history restoration
  events prompt a check; browser connectivity hints alone do not declare an outage.
- Recovery retries use a single timeout with delays of 2, 4, 8, 15, then at most
  30 seconds. There are no intervals or overlapping health requests. Background
  documents stop scheduling checks; returning to the foreground checks immediately.
  Manual Retry shares the same in-flight check and bypasses the backoff.
- A successful health response closes the screen and emits
  `karbon:connection-restored`. Interrupted GET/HEAD requests resume, so initial
  authentication/data loading can finish without restarting the page. The session
  guard also revalidates an existing session; expired/revoked credentials still
  follow the existing logout/login flow.
- Mutations are **never automatically replayed or queued**. A server might have
  committed a write before its response was lost. The existing error handling
  returns control to the form, allowing the user to check its state and retry.
  Caller cancellation remains effective while reads wait and while response bodies
  are being downloaded. A route that fails while health succeeds retains its error.

## Screen and state preservation

`connection-screen.js` lazily creates one full-screen native `<dialog>` above the
current document and any existing modal. No navigation, document reload, form
reset, session deletion, or blanket data refresh occurs on reconnection. Existing
forms, filters, scroll, and page DOM remain in memory. Focus is trapped in the
connection screen, Escape cannot dismiss it, and recovery restores prior focus.
The existing authentication concealment still protects pages during validation.

`connection.css`, imported by `input.css`, provides the Persian RTL screen,
server illustration, four blurred gradient orbs, keyboard focus indicator, and
live retry status. Colors use existing `--theme-*` and `--color-persian-blue`
tokens, following blue/red/green/black Settings changes, including cross-tab
changes. Only transforms animate; blur and gradients remain static. Reduced-motion
preferences disable the orb and retry-spinner animations. The closed dialog is
not rendered, and no animation JavaScript or new dependency is needed.

## Changed files

| Purpose | Files |
| --- | --- |
| Screen and animation | `frontend/src/connection.css`, `frontend/src/js/components/connection-screen.js`, `frontend/src/input.css` |
| Shared monitoring and startup | `frontend/src/js/components/connection.js`, `frontend/src/js/components/page-ready.js` |
| API and authentication integration | `frontend/src/js/components/api-cache.js`, `frontend/src/js/guards/auth-guard.js`, `frontend/src/js/auth/auth-api.js`, `frontend/src/js/attendance/face-api.js`, `frontend/src/js/reports/report-api.js` |
| Backend liveness | `backend/app.py` |
| Tests and disposable fixture | `frontend/tests/test_connection.cjs`, `frontend/tests/test_api_cache.cjs`, `frontend/tests/test_auth_guard.cjs`, `frontend/tests/serve_customers_fixture.py`, `backend/tests/test_health.py` |
| Documentation | `docs/connection-recovery.md` |

## Validation

```sh
npm --prefix frontend test
npm --prefix frontend run build
python3 -m unittest discover -s frontend/tests -p test_asset_paths.py
python3 -m unittest discover -s backend/tests -p test_health.py
```

Connection unit tests cover HTTP error classification, route-only network
failures, probe deduplication, suspended reads, mutation non-replay, cancellation,
timeouts, heartbeat/backoff, hidden-document lifecycle, and recovery events. Auth
tests cover revalidation and revocation after recovery; the health integration
test uses a disposable database and HTTP server.

Browser QA used the existing disposable fixture with a temporary local
fault-injection proxy, never the live database. Checked the outage screen on all
14 HTML documents, initial auth failure, Escape/focus behavior, automatic recovery
over an unsaved customer form, manual retry, live changes to all four themes, and
a 390px mobile viewport. To repeat manually, use
`frontend/tests/serve_customers_fixture.py`, interrupt backend connectivity after
opening an unsaved form, and restore it. Idle detection takes up to 30 seconds
plus the health check deadline; active failures trigger confirmation immediately.
