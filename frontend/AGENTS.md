# AGENTS.md

## What this is

`invite-llm` is the frontend of the `invite-litellm` project: a Vite 8 + TypeScript 6 SPA using Alpine.js (no other framework). The parent directory holds the Python `uv` backend that serves this SPA's production build and implements invite redemption — all frontend work happens here.

Current feature: a login form that authenticates against a LiteLLM proxy server, then lists the virtual keys visible to the connected user.

## Commands

- `npm run dev` — Vite dev server with HMR
- `npm run build` — `tsc && vite build`. Note: `tsc` is typecheck-only (`noEmit: true`); Vite does the actual bundling to `dist/`. Type errors fail the build.
- `npm run preview` — serve the production build locally

## Configuration

- The LiteLLM server URL is **not editable in the UI** — at runtime it comes from the backend: `init()` first awaits `loadServerConfig()` (same-origin `GET /config`, 5 s timeout; `vite.config.ts` proxies `/config` to `http://127.0.0.1:8000` in dev) and overrides `serverUrl` with the backend's `litellm_url` (its runtime `LITELLM_URL`). The same response also carries the app `version` (source of truth: `pyproject.toml`, via `importlib.metadata`), displayed in the footer as `v<x.y.z>` (hidden when no backend answers, e.g. bare dev server). The build-time value is only the fallback when no backend answers: `import.meta.env.LITELLM_URL` (`vite.config.ts` sets `envPrefix` to expose exactly that variable — not the whole `LITELLM_` prefix, so secrets like `LITELLM_MASTER_KEY` are never inlined). Set the fallback in `.env` (default: `http://localhost:4000`) or `.env.local`; restart the dev server after changing it.

There is no test framework, linter, or formatter configured. The only automated check is the `tsc` pass inside `build`.

## TypeScript constraints that will bite you

`tsconfig.json` enforces several strict options; code that violates them fails `npm run build`:

- **Imports use explicit `.ts` extensions** (`allowImportingTsExtensions`), e.g. `import { loginForm } from './login.ts'`. Match this style.
- **`verbatimModuleSyntax`** — type-only imports must use `import type { ... }`.
- **`erasableSyntaxOnly`** — no enums, namespaces, or constructor parameter properties. Use union types / `as const` instead.
- **`noUnusedLocals` / `noUnusedParameters`** — unused variables are build errors, not warnings.
- Target is ES2023 with `moduleResolution: "bundler"`.

## Architecture

Alpine.js SPA, no router, no build-time templating:

1. `index.html` holds all markup with Alpine directives (`x-data`, `x-model`, `@submit.prevent`, `x-if` templates). Static markup lives in HTML, not in TS.
2. `src/main.ts` is the bootstrap: imports the CSS, registers Alpine components via `Alpine.data('name', factory)`, then `Alpine.start()`.
3. `src/login.ts` exports the `loginForm()` component factory: form state, the `POST /v2/login` call, JWT session decode, and localStorage persistence (`litellm_session` key). Follow this pattern for new components: markup in `index.html`, logic as an exported factory function in `src/`.
4. Styling is one global stylesheet, `src/style.css`, with light/dark CSS custom properties on `:root`. `[x-cloak] { display: none }` prevents template flash before Alpine initializes.
5. Static assets in `src/assets/` are imported as URLs; `public/` files are served at the root path.
6. On load, `init()` also fires `checkServer()`: an unauthenticated `GET {server}/health/liveliness` with a 5 s timeout (`AbortSignal.timeout`). Any HTTP response — even 4xx/5xx — counts as reachable; only a network error (connection refused, CORS failure, timeout) sets `serverUnreachable`, which shows the `.server-alert` warning strip under the header (markup in `index.html`, style in `style.css`) with a Retry button that re-runs the check. The real proxy's `allow_origins=["*"]` makes the cross-origin ping work; a bare local test double without CORS headers would false-negative in a real browser.

`alpinejs` ships no TypeScript types — `@types/alpinejs` (devDependency) provides them.

## LiteLLM login API (verified against live server v1.100.1)

- **Endpoint: `POST {server}/v2/login`** with JSON body `{"username", "password"}`. Auth sources: `UI_USERNAME`/`UI_PASSWORD` env vars on the proxy, or DB users (email + password).
- **This endpoint is hidden from the OpenAPI spec** (`include_in_schema=False`) — you won't find it in `/openapi.json` or Swagger. Related hidden routes: `POST /login` (form-encoded, redirect + cookie), `POST /v3/login` (cross-origin, requires `control_plane_url`).
- Success: `200 {"redirect_url": "...", "token": "<session JWT>"}`. JWT claims include `user_id`, `user_email`, `user_role`, `key`, `login_method`, `exp`; it is HS256-signed with the master key (only decoded client-side here, never verified).
- Failure: `401` with body `{"error": {"message": "...", "type": "auth_error", "code": "401"}}` — note the error is under `error`, not `detail` (FastAPI convention).
- CORS: the proxy sets `allow_origins=["*"]` by default (override via `LITELLM_CORS_ORIGINS`), so cross-origin calls from the Vite dev server work without a proxy plugin.

### Authorizing API calls with the session (critical gotcha)

- **The session JWT itself is NOT accepted as a Bearer token** unless the proxy enables `enable_jwt_auth` (off by default; returns 401 "LiteLLM Virtual Key expected").
- Instead, use the JWT's **`key` claim** (a real virtual key, `sk-...`) as `Authorization: Bearer <key>` for management endpoints. This is what `login.ts` stores as `session.api_key`.
- Default admin login when `UI_USERNAME`/`UI_PASSWORD` are unset: username `admin`, password = master key.

### Listing keys: `GET /key/list`

- Params used: `?return_full_object=true&size=100` (size max 100). **Without `return_full_object=true` the response returns only key hashes** (`{"keys": ["<hash>", ...], "total_count", "current_page", "total_pages"}`), not key objects.
- Full objects carry `token` (the key **hash** — never display it), `key_name` (display stub like `sk-...zfmQ`, generated by LiteLLM at key creation), `key_alias`, `user_id`, `spend` (USD), `max_budget`, `expires` (ISO string or null), `blocked`, `models`.
- Visibility is server-scoped: non-admin callers only see their own keys ("internal user can only see their own keys" in `validate_key_list_check`); admins see all keys. Do **not** pass `user_id=<session user_id>` for filtering — env-credential admin sessions get `user_id=default_user_id`, which matches no DB rows and returns 0 keys.
- The **Allowed models** column (`keyModels`) shows a compact stub (first model, truncated at 24 chars, `… +N` when several; "All models" when `models` is null/empty; full list in the tooltip). Clicking opens the models modal (`openModelsModal`/`loadModels`): `GET /model/info` with the session key gives per-model data rendered as a **filterable, sortable table** (`visibleModels` getter: `modelsFilter` matches name or mode; `sortModels`/`sortHeader` toggle column and direction). Columns: Model, Type (`model_info.mode` badge: `chat`, `embedding`, `image_generation`, …), In/Out (first non-zero `input_/output_cost_per_*` field, unit from `costUnit` — `/Mtok`, `/Mchar`, `/M audiotok`, `/image`, `/s`, `/request`), Cache read/Cache write (`cache_read_input_token_cost`/`cache_creation_input_token_cost`, per Mtok), Context (`max_input_tokens` fallback `max_tokens`, `formatContext` → `128k`), Other (remaining non-zero `*cost*` fields, labelled via `modelCostParts`). Restricted keys filter the list to `key.models`; if `/model/info` fails it falls back to `GET /v1/models` (names only, no pricing).

### Team names: `GET /team/list` + `GET /team/info`

- `/team/list` is **admin-only**: internal users get 400 `{"detail":{"error":"Only admin users can query all teams/other teams..."}}`. It returns a **plain JSON array** of `{team_id, team_alias}`. `/key/list` has no `expand=team`.
- Resolution strategy in `login.ts`: try `/team/list` first (one call for admins), then for any team_id still missing call `GET /team/info?team_id=<id>` per distinct id — this **works for team members** (returns `{team_info: {team_alias}}`). Both are best-effort; failure degrades to `—`/short ids, not an error banner.
- Error shapes vary: LiteLLM uses `{"error": {"message"}}`, FastAPI validation uses `{"detail": ...}`, and some routes return `{"detail": {"error": "..."}}` — `extractErrorMessage` handles all three.
- The banner has view-switching buttons: **Virtual keys** (everyone), **Teams** and **Create team** (admin sessions only, JWT `user_role !== 'internal_user'`, exposed as the `isAdmin` getter), **Playground** and **Help** (everyone). They toggle the `view` state (`'keys' | 'teams' | 'create-team' | 'help' | 'playground'`) and swap the section inside the card; `showTeams()` lazy-loads the team list, and `logout()` resets the view. The Help view is static markup: a Python `openai` client example (built by the `pythonExample` getter in `login.ts`, interpolating the live `serverUrl`) and an explanation of the budget mechanism (per-key spend/budget, team budget, team member budget). The Playground view (`pg*` state, `sendChat()`) POSTs non-streaming to `{serverUrl}/chat/completions` with the user-pasted virtual key as Bearer (not the session key), sending the whole `pgMessages` history each turn; errors reuse `extractErrorMessage`, and `logout()` clears all playground state.
- Teams view columns: Name, Keys, Team budget, Member budget, Spend, Invite link (Team ID is intentionally hidden). `/team/list` returns only `{team_id, team_alias}`, so `loadTeams` enriches each row via `GET /team/info?team_id=<id>` (fetched in parallel, best-effort → `—` on failure): key count = length of the response's `keys` array (team's own keys, tokens stripped server-side), team budget = `team_info.max_budget`, member budget = `team_info.team_member_budget_table.max_budget` (the "Team Member Budget" field, stored as a separate budget row linked via `metadata.team_member_budget_id`; null when unset), spend = `team_info.spend` (team total, USD, formatted with `formatUsd`), invite code = `team_info.metadata.invite_code` (null/absent → `—`). The Invite link cell shows the code (hyperlinked to the full URL, new tab) and a Copy button; the post-creation panel link is likewise clickable.
- **Invite link format: `{app origin}/invite/{team_id}/{invite_code}`** (`window.location.origin` + path; e.g. `http://localhost:5173/invite/<team-uuid>/<8-char-code>`). Built by `teamInviteLink(team)` for the Teams table and inline in `createTeam()` (using the `team_id` from the `POST /team/new` response) for the post-creation panel. On load, `init()` parses `window.location.pathname` with `/^\/invite\/([^/]+)\/([^/]+)\/?$/` — a match opens a "Team invitation" modal showing the team name and the **default budget for the team's virtual keys** (= team member budget, `team_member_budget_table.max_budget`; resolved best-effort via `loadInviteTeamInfo()` → `GET /team/info`, which is auth-gated to admins/team members, so others see the raw team id and `—`). The modal then branches:

- **Session present** (`inviteStage !== 'done' && session`): button "Accept the invite and create virtual key" → `acceptInvite()` POSTs to the **same URL the page was called with** (`window.location.href`, i.e. `{origin}/invite/{team_id}/{code}`) with the session's `Authorization: Bearer <api_key>` header. This targets the parent backend's `POST /invite/{team_id}/{code}` route (`src/invite_litellm/app.py`) — see the root `AGENTS.md` for its contract. On 2xx the success stage shows a returned key if the response JSON has `key`/`token`/`api_key` (string), then reloads keys.
- **No session**: two tabs. "Sign in" uses **email/password** (email-typed input bound to `username`, reusing `submit()` → `POST /v2/login`; LiteLLM DB users authenticate with their email in the `username` field — on success the modal flips to the accept case automatically). "Create account" asks **full name, email, password** → `createInviteAccount()` POSTs `{full_name, email, password}` to the same invite URL (no auth header), same response handling. The parent backend implements this contract (creates the user, sets the password, adds them to the team, returns `{key, user_id, team_id}`; duplicate email → 409 with a "sign in instead" message).

Esc/outside/Close dismisses via `closeInviteModal()` (resets all invite state and `history.replaceState`s the URL back to `/`). The Vite dev server's SPA fallback serves `index.html` for the invite path; LiteLLM OSS itself has no self-join endpoint (`/team/member_add` is admin-only).
- **Create team** view (admin-only banner button, `view === 'create-team'`): form with Team name (required), optional Team member budget and Max team budget (USD, validated as positive numbers client-side), and a "Create invite link" checkbox. The team alias is always sent as `Invite/<name>` (idempotent prefix — typing `Invite/Foo` yourself is not doubled), and the success panel shows the prefixed name. When checked, `createTeam()` generates an 8-char code (`randomInviteCode`, Web Crypto `getRandomValues`, A-Za-z0-9) and sends it as `metadata: { invite_code: <code> }` in the `POST /team/new` payload (`NewTeamRequest`; see it for more optional fields like `models`, `members_with_roles`). The payload always includes `team_member_permissions: ['/key/generate', '/key/delete']` — without it, team members get 401 "Team member does not have permissions for endpoint" when generating/deleting their team keys (the invite backend also back-fills this at redemption for pre-existing teams). It's stored in the team's metadata — metadata survives alongside `team_member_budget_id`, which LiteLLM also writes into metadata. On success: with invite link, the form is replaced by a success panel showing the full invite link (`{origin}/{team_id}/{code}`, copy button, "Create another team", "View teams"); without, it switches straight to the Teams view and refreshes. Errors use `extractErrorMessage`. Form state resets on entry (`showCreateTeam`) and on `logout`.

### Regenerating keys (OSS "regenerate" simulation)

- `POST /key/regenerate` exists but is **Enterprise-only** — the OSS proxy returns 500 "Regenerating Virtual Keys is an Enterprise feature".
- The app simulates regeneration: `POST /key/delete` (old hash) then `POST /key/generate` with the old key's metadata copied (`buildRegenPayload` in `login.ts`): alias, owner, team, org, spend, budgets, duration, models, aliases, config, metadata, permissions, limits. Remaining validity is preserved by converting `expires` into `duration: "<seconds>s"` (the duration parser accepts `<n>s/m/h/d/w/mo`).
- **Order is delete → generate**: key aliases are globally unique ("Key with alias ... already exists"), so the replacement cannot take the old name until the old key is deleted.
- Deleting an already-deleted hash returns 404 `{"error":{"message":"{'error': 'No keys found'}"}}` — treated as success for retry-safety.
- `user_id`/`organization_id` are only copied for non-internal_user sessions (internal users can't create keys for other users; omitting them makes the new key default to the caller). Same for **`allowed_routes`**: it's proxy-admin-only ("Only proxy admins can set `allowed_routes`"), so internal users get the `key_type` preset copied instead (e.g. `llm_api` → `llm_api_routes`).

## Other notes

- Part of the parent git repository (the root repo tracks `frontend/` directly; no separate repo here).
- A live LiteLLM server for testing runs at `http://localhost:4000` (swagger at `/`, openapi at `/openapi.json`).
- A static `<footer class="footer">` at the end of `index.html` shows the project name as a link (`Invite-LiteLLM` → `https://github.com/oschwand/invite-llm`), the version, and "Connected to `<serverUrl>`" (reactive `x-text`, so it reflects the backend-provided `litellm_url` or the fallback). **Bump the version manually alongside the `pyproject.toml` version** (kept static because the Docker frontend build stage only copies `frontend/`, so build-time injection from the parent project is not possible).
