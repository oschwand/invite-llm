# invite-litellm

Self-service key management for a [LiteLLM proxy](https://docs.litellm.ai/): a small web app
where admins create teams and share invite links, and team members sign up, accept invites,
and manage their own virtual keys — no proxy admin required.

It is made of two parts living in one repository:

- **`src/invite_litellm/`** — a FastAPI backend (Python ≥ 3.13, managed with [`uv`](https://docs.astral.sh/uv/))
  that serves the built frontend and redeems invite links by calling the LiteLLM proxy's admin API.
- **`frontend/`** — a Vite + TypeScript + [Alpine.js](https://alpinejs.dev/) single-page app that
  logs into the LiteLLM proxy and manages virtual keys and teams.

## Features

- **Login** against the LiteLLM proxy (`POST /v2/login`), with the session persisted in the browser.
- **Virtual keys dashboard**: list your keys with spend, budget, expiry; regenerate (delete + recreate,
  since regeneration is Enterprise-only in the OSS proxy) and delete them.
- **Teams** (admin only): browse teams with their budgets, spend and invite links; create teams with a
  member budget and a generated invite link.
- **Invite links**: opening `/invite/{team_id}/{invite_code}` shows a modal to either sign in with an
  existing account or create a new one (name, email, password). Accepting the invite adds the user to
  the team and issues a team virtual key (budget = the team's member budget), shown once.
- Teams created through the app automatically grant members permission to generate/delete their own keys.

## Requirements

- Python ≥ 3.13 and [`uv`](https://docs.astral.sh/uv/)
- Node.js and npm (for building the frontend)
- A running [LiteLLM proxy](https://docs.litellm.ai/docs/proxy/quick_start) with its master key,
  reachable from both the browser (login, key management) and the backend (invite redemption).

## Configuration

Create a `.env` file at the repository root (gitignored) for the backend:

```sh
LITELLM_URL=http://localhost:4000      # LiteLLM proxy base URL
LITELLM_MASTER_KEY=sk-...              # required for invite redemption
# STATIC_DIR=/path/to/built/frontend   # optional, defaults to frontend/dist
```

For the frontend, `frontend/.env` (also untracked) can override the proxy URL used by the browser:

```sh
VITE_LITELLM_URL=http://localhost:4000
```

Real environment variables take precedence over `.env` files. The frontend URL is baked in at
build/dev start, so restart the Vite server after changing it.

## Running

Production-style (backend serves the built SPA on `http://127.0.0.1:8000`):

```sh
uv sync                    # install the Python backend
cd frontend && npm install && npm run build && cd ..
uv run invite-litellm      # serve frontend/dist and the invite API
```

Development (Vite dev server with hot reload on `http://localhost:5173`; invite URLs work there too
via Vite's SPA fallback, and the SPA calls the backend route on the same invite URL):

```sh
cd frontend
npm install
npm run dev
```

## How invite redemption works

`POST /invite/{team_id}/{invite_key}` (implemented in `src/invite_litellm/app.py`) validates the code
against the team's stored invite code, then:

1. Identifies the caller: either a signed-in user (session virtual key sent as a Bearer token) or a
   new account created from the `{full_name, email, password}` JSON body.
2. Adds the user to the team (idempotent if already a member) and ensures team members are allowed to
   manage their own keys.
3. Generates a virtual key with the team's member budget and returns `{key, user_id, team_id}`.

All upstream calls use the LiteLLM master key; upstream failures surface as HTTP 502 with a readable
message. Unknown team → 404, wrong code → 403, duplicate email → 409 with a "sign in instead" hint.

## Repository layout

```
src/invite_litellm/   FastAPI app: static file server + invite redemption backend
frontend/             Vite + TypeScript + Alpine.js SPA (see frontend/AGENTS.md)
uv.lock, pyproject.toml
```

There are no tests, linters or CI configured; the only automated check is the `tsc` typecheck run by
`npm run build`.

## License

MIT — see [LICENSE](LICENSE).
