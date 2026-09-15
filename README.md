# invite-litellm

Self-service key management for a [LiteLLM
proxy](https://docs.litellm.ai/): a small web app where admins create
teams and share invite links, and team members sign up, accept
invites, and manage their own virtual keys. Invite links give a
limited budget.

It is made of two parts:

- a FastAPI backend managing the admin-only operations.
- a single-page app frontend managing user keys.

A running [LiteLLM
  proxy](https://docs.litellm.ai/docs/proxy/quick_start) is needed
  with admin access (master key), reachable from both the browser
  (login, key management) and the backend (invite redemption).

## Features

- **Login** against the LiteLLM proxy.
- **Invite links**: either sign in with an existing account or create
  a new one (name, email, password). Accepting the invite adds the
  user to the team and issues a team virtual key (budget = the team's
  member budget).
- **Budget**: enforced by the proxy with a maximum amount chosen during
  team creation.
- **Virtual keys dashboard**: list your keys with spend, budget,
  expiry; regenerate and delete them.
- **Teams** (admin only): browse teams with their budgets, spend and
  invite links; create teams with a member budget and a generated
  invite link.

## Running

### Manual build

Requirements:

- Python ≥ 3.13 and [`uv`](https://docs.astral.sh/uv/)
- Node.js and npm (for building the frontend)

```sh
uv sync
cd frontend && npm install && npm run build && cd ..
uv run invite-litellm
```

### Docker

A prebuilt multi-arch image (amd64/arm64) is published on
[GitHub Container Registry](https://github.com/oschwand/invite-llm/pkgs/container/invite-llm):

```sh
docker run --rm -p 8000:8000 \
  -e LITELLM_URL=http://your.litellm:4000 \
  -e LITELLM_MASTER_KEY=sk-... \
  ghcr.io/oschwand/invite-llm
```

### Configuration

Configuration can be made either with a `.env` file or with environment variables.

```sh
LITELLM_URL=http://localhost:4000      # LiteLLM proxy base URL
LITELLM_MASTER_KEY=sk-...              # required for invite redemption
```

## Usage

### For admin

1. Sign in with an admin account (by default username `admin` and the proxy master key,
   or the `UI_USERNAME`/`UI_PASSWORD` pair configured on the proxy).
2. Open the **Teams** view and click **Create team**: give the team a name, optionally a
   max team budget and a per-member budget, and tick **Create invite link**.
3. Copy the generated invite link (`http://<app>/invite/<team_id>/<code>`) and share it
   with the people you invite. The link (and a copy button) also appears in the Teams
   table for future reference.

Members are automatically granted permission to generate and delete their own team keys.

Beware that teams created this way are granted access to all models on
the proxy. Use the LiteLLM dashboard to configure more precisely.

### For users

1. Open the invite link you received. The invitation modal shows the team name and the
   budget granted to your virtual key.
2. Either **create an account** (full name, email, password) or **sign in** if you already
   have one.
3. Click **Accept the invite**: you join the team and a virtual key (`sk-...`) is created.
   It is displayed **once** — copy and store it somewhere safe.
4. Sign in to the dashboard with your email and password to see your keys, spend and
   budget, and to regenerate or delete keys.

## License

MIT — see [LICENSE](LICENSE).

## AI-disclosure

Entirely developed with
[Crush](https://github.com/charmbracelet/crush) and [GLM
5.3](https://docs.z.ai/guides/llm/glm-5.3).

