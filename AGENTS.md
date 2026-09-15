# AGENTS.md

## What this is

`invite-litellm` is a monorepo-style project with two independent parts:

- **`src/invite_litellm/`** — the Python `uv` backend (FastAPI), two jobs: (1) serve the frontend production build from `frontend/dist/` — a `GET /invite/{team_id}/{invite_code}` route serves `index.html` **directly** (no redirect, so the invite URL stays in the address bar for the SPA to parse) and a catch-all `GET /{file_path:path}` serves static files (`FileResponse`, 404 on missing files and path-traversal attempts); it also exposes `GET /config` returning `{"litellm_url": ..., "version": ...}` — registered *before* the catch-all, or it would be shadowed — which the SPA fetches on load to adopt the backend's runtime `LITELLM_URL` and to display the app version in the SPA footer (single source of truth: `[project] version` in `pyproject.toml`, read via `importlib.metadata` from the installed dist-info, so it also works in the container where no source tree is present); (2) redeem invite links: `POST /invite/{team_id}/{invite_key}` creates a virtual key on the LiteLLM proxy server-side. `main()` runs it with uvicorn on the `HOST`/`PORT` env vars (defaults `127.0.0.1:8000`; the Dockerfile sets `HOST=0.0.0.0`). At startup the lifespan pings unauthenticated `GET {LITELLM_URL}/health/liveliness` (5 s timeout, any HTTP response = reachable — same semantics as the frontend's check) and logs an INFO line on success or a warning if the proxy is down; startup is never blocked. The module's logger carries its own stderr handler (uvicorn-compatible format, guarded against duplicate handlers on reload) since uvicorn configures no root handlers. Requires `npm run build` in `frontend/` first.
- **`frontend/`** — the SPA: a Vite 8 + TypeScript 6 + Alpine.js app that logs into a LiteLLM proxy server and manages its virtual keys. **Read `frontend/AGENTS.md` before any frontend work** — it contains hard-won knowledge about the LiteLLM API (hidden login endpoint, auth via the JWT `key` claim, key-regeneration simulation, error-shape quirks) that is not discoverable from the code or the LiteLLM OpenAPI spec.

The Python side serves the built SPA **and** implements the invite-redemption backend that the SPA's invite modal calls (frontend state/logic is still all in `frontend/`).

### Invite redemption: `POST /invite/{team_id}/{invite_key}` (in `app.py`)

Validates the invite code against the team's `metadata.invite_code` (`GET /team/info`, admin auth) → 404 unknown team, 403 bad code. Then two caller modes (matching the frontend invite modal):

- **`Authorization: Bearer <virtual key>`** (signed-in user): resolves the caller's `user_id` via `GET /key/info?key=...` (401 on unknown key).
- **No auth + JSON body `{full_name, email, password}`** (signup): creates the user with `POST /user/new` (`auto_create_key: false`) then sets the password via `POST /user/update` (LiteLLM's `/user/new` has no password field; duplicate email → clean 409 "already exists — sign in instead").

Both modes then enforce **one key per user per team**: `_user_team_key_exists` walks `GET /key/list` (master key, `return_full_object=true`, paginated 100/page, hard cap 20 pages) matching `user_id`+`team_id`; a hit aborts with a clean **409 "You already have a virtual key for this team"** *before* `team/member_add` runs (the frontend's invite modal surfaces the `detail` via `extractErrorMessage`; deleting/regenerating the old key re-enables redemption). Then `POST /team/member_add` ("already in team" errors tolerated → idempotent) and `POST /key/generate` with the team's member budget (`team_member_budget_table.max_budget`) as `max_budget` and `models: ["all-team-models"]` (LiteLLM sentinel: the key inherits exactly the team's models — teams themselves are created without a `models` list, so LiteLLM defaults them to all proxy models). Returns `{key, user_id, team_id}` — the plaintext `sk-...` key is shown once by the frontend. All upstream LiteLLM calls use the master key; errors are re-raised as FastAPI `detail` strings the frontend's `extractErrorMessage` understands (502 = upstream failure, 503 = missing master key config).

During invite validation the backend also **ensures team members can manage their own keys**: LiteLLM blocks team members from `/key/generate`/`/key/delete` (401 "Team member does not have permissions for endpoint") unless the team's `team_member_permissions` list includes those routes. `createTeam()` in the frontend now sends `team_member_permissions: ['/key/generate', '/key/delete']` on `POST /team/new`; `_check_invite` additionally back-fills missing routes via `POST /team/permissions_update` (idempotent, preserves existing entries) so teams created before this — whose invite links are already shared — also work. (Observed quirk: the session key from `POST /v2/login` may be invalidated after key-management calls — subsequent requests 401 "No api key passed in" until re-login.)

Config comes from env vars, with `<repo root>/.env` loaded at import via `python-dotenv` (real env vars win): `LITELLM_URL` (default `http://localhost:4000`), `LITELLM_MASTER_KEY` (required for the POST route), `STATIC_DIR`. The `.env` is gitignored.

## Commands

Python side (requires Python >= 3.13, pinned in `.python-version`):

```sh
uv sync                  # install dependencies into .venv
uv run invite-litellm    # serve frontend/dist on http://127.0.0.1:8000
```

The served directory defaults to `<repo root>/frontend/dist` and can be overridden with the `STATIC_DIR` env var (useful when the package is installed outside the source tree). Server config (`LITELLM_URL`, `LITELLM_MASTER_KEY`) is read from env vars / the repo-root `.env`.

Frontend side:

```sh
cd frontend
npm run dev        # Vite dev server with HMR
npm run build      # tsc (typecheck-only, noEmit) then vite build; type errors fail the build
npm run preview    # serve the production build
```

Container (multi-stage `Dockerfile` at the repo root — `node:22-alpine` builds the SPA, a `python:3.13-slim` + uv stage builds the venv from `uv.lock`, and the final slim stage copies only `.venv` + `frontend/dist` and runs as non-root):

```sh
podman build -t invite-litellm --build-arg LITELLM_URL=https://litellm.example.com .
podman run -p 8000:8000 -e LITELLM_MASTER_KEY=sk-... invite-litellm
```

The `LITELLM_URL` build arg sets only the runtime default — nothing is baked into the SPA bundle. The frontend gets the URL at runtime from the backend's `GET /config`, so `-e LITELLM_URL=...` on `podman run` reaches both the backend's upstream calls and the browser: one value, no drift. `LITELLM_MASTER_KEY` is runtime-only (`-e`), never a build arg — `.dockerignore` keeps `.env` files out of the image entirely.

There are **no tests, linters, formatters, or CI** configured anywhere. The only automated check in the whole repo is the `tsc` pass inside `npm run build`.

## Git

Single repository at the root; `frontend/` is a subdirectory, not a submodule or separate repo (the "not a git repository" note in `frontend/AGENTS.md` predates the frontend being committed). Commits touch either root-level Python files or `frontend/` — keep changes scoped accordingly.

## Gotchas

- The static route in `app.py` is a **catch-all** — any new API endpoint must be registered *before* it in the file, or it will be shadowed.
- The repo-root `.env` (holding `LITELLM_MASTER_KEY`, `LITELLM_URL`) is gitignored and machine-local — it must contain the LiteLLM proxy's **master key** for invite redemption to work (env-credential admin).
- `frontend/.env` (holding `LITELLM_URL`, default `http://localhost:4000` — same variable as the backend; `frontend/vite.config.ts` exposes exactly this one non-`VITE_` var via `envPrefix`, deliberately not the whole `LITELLM_` prefix so `LITELLM_MASTER_KEY` can never be inlined into the bundle) is untracked and machine-local. The LiteLLM server URL is baked in at Vite build/dev-start time; changing it requires a dev-server restart, and serving via the Python backend serves only the *built* bundle.
- The Python build backend is `uv_build` with a `src/` layout — new modules go in `src/invite_litellm/`, not the repo root.
- A live LiteLLM proxy for testing is expected at `http://localhost:4000` (swagger at `/`, OpenAPI at `/openapi.json`). Its `/v2/login` route is hidden from that OpenAPI spec — see `frontend/AGENTS.md`.
