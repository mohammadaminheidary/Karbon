# Project layout and dependency map

This map was recorded before the directory migration. The working tree already
contained inventory settings and warehouse UI changes; those files are retained
locally and excluded from the reorganization commit. The local handoff remains
untracked as well.

## Dependency and execution map

- Root `start.py` builds the navigation and Tailwind CSS, then runs Uvicorn
  `app:app` with `backend/` as its working directory and the static Python server.
- `backend/app.py` imports the local `database`, `models`, `routes`, `services`
  and `security` modules. Routes depend on schemas, services, authentication and
  database sessions. Services depend on models/configuration and each other.
  These module names and the backend working directory remain unchanged.
- Application import runs the existing schema initialization/migrations.
  Verification must use a disposable `KARBON_DATABASE_PATH` and test JWT secret.
- `backend/config.py` selects `~/.karbon/karbon.db` by default, or the existing
  `KARBON_DATABASE_PATH`. Relative overrides retain their backend-relative meaning
  when launched by `start.py`. `KARBON_TIMEZONE` is unchanged.
- `backend/security/jwt.py` loads `~/.karbon/.env`; biometric encryption uses
  `KARBON_FACE_KEY`, `KARBON_FACE_KEY_PATH`, or `face.key` beside the database.
  No user database, configuration, encryption key or biometric model is moved.
- `backend/services/face_service.py` resolves ONNX files relative to `backend/`.
- The bank initializer reads the bundled `data/banks.json`. This reference catalog
  moves to `backend/data/`; its logo URLs remain `/assets/image/banks/*.svg`.
- HTML entry points reference `/src/`, `/assets/`, `/page/` and `/index.html`.
  JS uses relative ES imports, absolute page URLs and the existing API origin
  `http://127.0.0.1:8000/api`. CSS imports neighboring stylesheets and uses
  `../assets/` for fonts/backgrounds. Moving the complete frontend tree together
  preserves all these browser URLs and relative imports.
- `scripts/build_navigation.py` resolves its root from its own file, reads
  `src/templates/navbar.html` and renders `index.html` and `page/*.html`.
  The script and its complete input tree move together into `frontend/`.
- Tailwind/package files, installed Node dependencies, HTML, CSS, JS, templates
  and visual assets move into `frontend/`. The static server serves that directory.
- Python API/migration tests move to `backend/tests/`; Python static-server and
  navigation tests, Node tests and browser fixture/tests move to `frontend/tests/`.
  Backend test subprocesses retain the backend working directory. The browser
  fixture serves `frontend/` and starts the API from `backend/` with temporary data.
- Shared domain documentation stays in `docs/`. The handoff and existing proposal
  move under `docs/`; root README, license, ignore rules and editor settings stay.

## Intended structure

```text
start.py
README.md / LICENSE / .gitignore / .vscode/
backend/
  app.py / run.py / create_user.py / config.py / database.py
  requirements.txt
  routes/ / schemas/ / services/ / models/ / security/
  face_models/ / data/banks.json / tests/
frontend/
  index.html / page/ / src/ / assets/
  package.json / package-lock.json / node_modules/
  serve_frontend.py / scripts/ / tests/
docs/
  project-layout.md / reorganization-verification.md / artifacts/ / domain guides
```

`node_modules/`, generated CSS and Python caches remain ignored. The launcher
keeps ports 8000/5501, the login URL, backend imports, API contracts and CORS.

## Verification

See [the verification report](reorganization-verification.md) for executed checks,
startup/shutdown results, data preservation and the three browser failures also
reproduced in the original layout.
