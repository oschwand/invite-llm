# AGENTS.md

## What this is

`invite-llm` is the frontend of the `invite-litellm` project: a Vite 8 + TypeScript 6 SPA using Alpine.js (no other framework). It sits inside a parent directory containing a separate (currently empty) Python `uv` project — don't confuse the two; all frontend work happens here.

Current feature: a login form that authenticates against a LiteLLM proxy server.

## Commands

- `npm run dev` — Vite dev server with HMR
- `npm run build` — `tsc && vite build`. Note: `tsc` is typecheck-only (`noEmit: true`); Vite does the actual bundling to `dist/`. Type errors fail the build.
- `npm run preview` — serve the production build locally

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

`alpinejs` ships no TypeScript types — `@types/alpinejs` (devDependency) provides them.

## LiteLLM login API (verified against live server v1.100.1)

- **Endpoint: `POST {server}/v2/login`** with JSON body `{"username", "password"}`. Auth sources: `UI_USERNAME`/`UI_PASSWORD` env vars on the proxy, or DB users (email + password).
- **This endpoint is hidden from the OpenAPI spec** (`include_in_schema=False`) — you won't find it in `/openapi.json` or Swagger. Related hidden routes: `POST /login` (form-encoded, redirect + cookie), `POST /v3/login` (cross-origin, requires `control_plane_url`).
- Success: `200 {"redirect_url": "...", "token": "<session JWT>"}`. JWT claims include `user_id`, `user_email`, `user_role`, `key`, `login_method`, `exp`; it is HS256-signed with the master key (only decoded client-side here, never verified).
- Failure: `401` with body `{"error": {"message": "...", "type": "auth_error", "code": "401"}}` — note the error is under `error`, not `detail` (FastAPI convention).
- CORS: the proxy sets `allow_origins=["*"]` by default (override via `LITELLM_CORS_ORIGINS`), so cross-origin calls from the Vite dev server work without a proxy plugin.

## Other notes

- Not a git repository (as of this writing).
- A live LiteLLM server for testing runs at `http://localhost:4000` (swagger at `/`, openapi at `/openapi.json`).
