# Authentication and access-control audit

Date: 2026-11-01

## Findings and fixes

- Logout previously removed only the browser token. A copied token stayed usable until expiry. The authenticated `POST /api/auth/logout` endpoint now increments the account's existing `auth_version`, invalidating all its outstanding tokens. The UI waits for server confirmation; a failed network request shows an error and allows retry.
- Session validation could reuse a cached `/auth/me` result. Validation now uses `no-store`. Private API responses also carry `Cache-Control: no-store` and `Pragma: no-cache`.
- Warehouse initialization omitted the shared authentication guard. It now validates before initialization, like the other protected pages. All 13 protected documents start concealed, including with JavaScript disabled, and reveal their content only after successful server validation. Their HTML templates and static assets remain publicly served; the backend protects the actual application data.
- History restoration and other open tabs could retain rendered content after logout. Protected documents conceal content on `pagehide`, revalidate on history restoration/focus/visibility return, redirect on authentication storage changes, and handle token expiry. Network failures preserve credentials but conceal protected content and offer the existing retry flow.
- JWT validation did not require an expiry claim. It now requires expiry and subject claims, while preserving the fixed HS256 algorithm, stable account ID, database-backed version checks, and one-hour token lifetime.
- Unknown usernames skipped bcrypt verification, creating a timing distinction. Missing accounts now perform dummy bcrypt verification, and invalid logins retain a generic error.
- Login throttling was IP-only, unsynchronized, and bypassable by concurrent requests. The bounded, thread-safe limiter now reserves in-flight attempts and tracks both source IP and account keys. Five failed attempts within 60 seconds temporarily block further attempts; account limits span different IPs. Password-confirmation endpoints use the same reservation mechanism. Successful logins do not erase the source IP's failed-attempt budget.
- Existing bcrypt storage was appropriate, but its work factor was implicit and older hashes had no upgrade path. Hashing now explicitly uses cost 12, refuses silent UTF-8 truncation, and upgrades lower-cost hashes after a successful login using a conditional database update. Existing accounts and passwords remain valid.
- Newly chosen passwords previously allowed a single character. New passwords and administrator resets now require at least 15 characters, with bcrypt's 72-byte maximum enforced. Login still accepts existing shorter passwords. Password changes retain current-password verification, confirmation, rate limiting, atomic updates, and revocation of old tokens.
- No production hardcoded passwords or JWT signing keys were found in the reviewed tracked authentication/launcher code. Test-only credentials and keys remain confined to test fixtures. Production signing keys are loaded from external environment configuration.

## Modified components

Backend:

- `backend/security/password.py`, `jwt.py`, `login_rate_limit.py`
- `backend/services/auth_service.py`, `auth_settings.py`
- `backend/routes/auth.py`, `schemas/auth_schema.py`, `app.py`, `create_user.py`

Frontend:

- `frontend/src/js/guards/auth-guard.js`
- `frontend/src/js/auth/auth-api.js`, `auth-storage.js`, `security-settings.js`
- `frontend/src/js/components/navbar.js`, `page-bootstrap.js`
- `frontend/src/js/page/warehouse.js`
- `frontend/index.html`, all protected `frontend/page/*.html`, and `frontend/src/input.css`

Tests:

- `backend/tests/test_access_security.py`, `test_login_throttling.py`, `test_auth_settings.py`
- `frontend/tests/access_security_browser.mjs`, `test_auth_guard.cjs`

The prior startup-delay changes remain in place. No dependencies or database tables were added.

## Verification

- Full backend suite: 158 tests completed successfully, with one optional real-face inference test skipped because test images were not configured. The first run detected a Content-Length regression; privacy headers now use ASGI middleware that preserves compression and streaming behavior, and the full rerun passed.

- 88 frontend tests passed.
- 10 account/password/migration tests passed, covering credential changes, password confirmation, UTF-8 boundaries, redaction, concurrent changes, revocation, account preservation, and administrator resets.
- Real HTTP tests rejected unauthenticated requests to all 85 registered protected API operations. Also verified missing expiry, expired/tampered tokens, invalid account/version claims, logout revocation, legitimate login/navigation, generic login errors, old bcrypt upgrades, and repeated-attempt lockout.
- Two deterministic throttling tests passed: account lockout across IPs with expiry, and concurrent admission with cleanup after exceptions.
- Chrome checks passed for all 13 protected pages: direct unauthenticated URLs, JavaScript-disabled concealment, valid sessions, navigation, refresh, logout, cross-tab logout, browser history, copied revoked tokens, and invalid expired tokens, plus server-validation failure and recovery. Genuine signed expired tokens are separately tested at the API boundary.
- 12 frontend Python tests passed, covering static serving, private-file protection, launch behavior, markup, assets, and production builds.
- Production frontend build passed.

## Remaining risks and scope

- Bearer tokens remain in localStorage to preserve the current architecture. An XSS vulnerability or malicious browser extension could steal them. A future same-origin deployment can use Secure, HttpOnly cookies with an explicit CSRF design.
- Throttling is process-local and resets on restart; it is intended for the existing single-process local service. Multi-worker or public deployments need shared, durable throttling, trusted-proxy configuration, and edge request limits. Bounded limiter storage can evict entries under sufficiently distributed abuse.
- The current application uses loopback HTTP. Any deployment beyond the local machine must use HTTPS and a high-entropy signing key kept outside source control, with appropriate OS file permissions.
- Logout deliberately revokes all sessions for that account. A successful server response is required to guarantee revocation; offline logout cannot make a remote server invalidate a token.
- Static page templates are public assets, not server-authenticated HTML routes. Confidential data and mutations require authenticated APIs. Concealment prevents ordinary unauthenticated rendering but is not an authorization mechanism.
- The existing shared-workspace authorization model remains unchanged. This work does not introduce roles, per-record ownership, MFA, password breach screening, or an external penetration test.

Guidance checked against the [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), and [Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
