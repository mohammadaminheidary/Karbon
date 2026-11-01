# Karban

**Karban** is a modern business management platform designed to simplify and centralize daily operations, financial management, customer records, orders, work schedules, tasks, and business reporting in one place.

The project focuses on providing a simple, intuitive, and efficient management experience while reducing manual work and making business data easier to organize, track, and analyze.

### Core Features

- 📊 Management Dashboard
- 👥 Customer Management
- 📦 Order & Project Management
- 💰 Financial & Accounting Management
- 🏦 Account & Transaction Tracking
- 📅 Work Schedule Management
- ✅ Task & To-Do Management
- 📈 Reports & Business Analytics
- 🗃️ Centralized Database
- 🔐 Secure and scalable architecture

**Karban — Manage smarter. Work better.**

### Development

Run these commands from the project root:

```sh
python3 -m pip install -r backend/requirements.txt
npm --prefix frontend install
python3 start.py
```

`python start.py` works when `python` is the installed Python 3 interpreter.
The launcher also works from another directory using its absolute path. It builds
frontend assets, starts the API at `http://127.0.0.1:8000` and the frontend at
`http://127.0.0.1:5501`, then opens `/page/login-page.html`. Ctrl+C or SIGTERM
stops the servers it started, including Uvicorn's reload worker. Existing servers
on those ports are reused and remain running when this launcher stops.

- `backend/`: API, models, services, schemas, security, bundled bank catalog,
  biometric models, Python dependencies and API tests.
- `frontend/`: pages, templates, JavaScript, styles, assets, Node dependencies,
  build tools, static development server and frontend/browser tests.
- `docs/`: shared domain guides, dependency map, verification report and existing artifacts.

Database, environment and encryption settings are unchanged: the default database
is `~/.karbon/karbon.db`, JWT configuration loads from `~/.karbon/.env`, and the
face encryption key remains beside the selected database unless overridden.
`KARBON_DATABASE_PATH`, `KARBON_TIMEZONE`, `KARBON_JWT_SECRET`, `KARBON_FACE_KEY`
and `KARBON_FACE_KEY_PATH` retain their behavior. Relative database/key overrides
are resolved from `backend/` when using the root launcher. Backend modules retain
their local import names; use `python3 backend/run.py` from the root (or its
absolute path), or run `python3 -m uvicorn app:app --reload` inside `backend/`.
Do not run the app against production data merely to verify this reorganization.

Settings includes grouped management tools and account security. Password changes
require the current password, persist in SQLite, and revoke
previous sessions while renewing the session making the change. New passwords
must be nonempty, contain a non-space character, and fit within 72 UTF-8 bytes
(bcrypt's limit). Username changes are currently unavailable.
Startup adds the `users.auth_version` column automatically to existing databases.
Sessions created before this update require one new login to obtain tokens tied
to a stable user ID. The admin reset script also revokes previous sessions.

```sh
npm --prefix frontend run build
npm --prefix frontend run dev
npm --prefix frontend test
python3 -m unittest discover -s backend/tests -v
python3 -m unittest discover -s frontend/tests -v
python3 frontend/scripts/build_navigation.py --check
```

Browser tests use `frontend/tests/serve_customers_fixture.py`, which creates a
disposable database. Set `KARBON_PLAYWRIGHT_PATH` and `KARBON_CHROME_PATH` if
Playwright or Chromium are installed outside the frontend's Node dependencies.
See [the dependency map](docs/project-layout.md) for execution and storage paths.

For the production configuration, run `python3 start.py --production`. It uses
one API process without reload and serves the generated `frontend/dist/` files.
Alternatively, run `npm --prefix frontend run build` followed by
`npm --prefix frontend run serve` alongside the API. Native ES modules are
content-hashed, dependencies are preloaded, optional tools load on demand, and
text assets have precompressed gzip representations. HTML revalidates; versioned
assets cache for one year. Builds retain old immutable chunks for open tabs.
`KARBON_API_BASE_URL` optionally sets the API origin **at build time**; the default
remains `http://127.0.0.1:8000/api`.

See [the current performance audit](docs/performance/2026-10-29-followup.md) for
reproducible synthetic benchmarks and the limits of their results.
