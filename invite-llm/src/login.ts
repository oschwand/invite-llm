const STORAGE_KEY = 'litellm_session'

interface Session {
  token: string
  api_key: string
  user_id: string
  user_email: string
  user_role: string
  expires_at: number
}

interface VirtualKey {
  token: string
  key_name: string | null
  key_alias: string | null
  team_id: string | null
  user_id: string | null
  spend: number | null
  max_budget: number | null
  expires: string | null
  blocked: boolean | null
}

interface ErrorBody {
  error?: { message?: string } | string
  detail?: { message?: string; error?: string } | string
  message?: string
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const encoded = token.split('.')[1]
  if (encoded === undefined) return null
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  try {
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  } catch {
    return null
  }
}

function sessionFromToken(token: string): Session | null {
  const payload = decodeJwtPayload(token)
  if (payload === null || typeof payload.exp !== 'number') return null
  if (payload.exp * 1000 <= Date.now()) return null
  return {
    token,
    api_key: String(payload.key ?? ''),
    user_id: String(payload.user_id ?? 'unknown'),
    user_email: String(payload.user_email ?? ''),
    user_role: String(payload.user_role ?? ''),
    expires_at: payload.exp,
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const data = body as ErrorBody
  if (typeof data.error === 'string') return data.error
  if (typeof data.error?.message === 'string') return data.error.message
  if (typeof data.detail === 'string') return data.detail
  if (typeof data.detail?.error === 'string') return data.detail.error
  if (typeof data.detail?.message === 'string') return data.detail.message
  if (typeof data.message === 'string') return data.message
  return null
}

function parseVirtualKey(raw: Record<string, unknown>): VirtualKey {
  return {
    token: String(raw.token ?? ''),
    key_name: typeof raw.key_name === 'string' ? raw.key_name : null,
    key_alias: typeof raw.key_alias === 'string' ? raw.key_alias : null,
    team_id: typeof raw.team_id === 'string' ? raw.team_id : null,
    user_id: typeof raw.user_id === 'string' ? raw.user_id : null,
    spend: typeof raw.spend === 'number' ? raw.spend : null,
    max_budget: typeof raw.max_budget === 'number' ? raw.max_budget : null,
    expires: typeof raw.expires === 'string' ? raw.expires : null,
    blocked: raw.blocked === true,
  }
}

export function loginForm() {
  return {
    serverUrl: 'http://localhost:4000',
    username: '',
    password: '',
    loading: false,
    error: '',
    copiedValue: null as string | null,
    session: null as Session | null,

    keys: [] as VirtualKey[],
    teamNames: {} as Record<string, string>,
    keysLoading: false,
    keysError: '',

    init() {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw === null) return
      try {
        const saved = JSON.parse(raw) as { token?: string }
        const session = saved.token !== undefined ? sessionFromToken(saved.token) : null
        if (session === null) {
          localStorage.removeItem(STORAGE_KEY)
          return
        }
        this.session = session
        void this.loadKeys()
      } catch {
        localStorage.removeItem(STORAGE_KEY)
      }
    },

    async submit() {
      this.error = ''
      this.loading = true
      try {
        const base = this.serverUrl.replace(/\/+$/, '')
        const response = await fetch(`${base}/v2/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: this.username, password: this.password }),
        })
        const body: unknown = await response.json().catch(() => null)
        if (!response.ok) {
          this.error = extractErrorMessage(body) ?? `Login failed (HTTP ${response.status})`
          return
        }
        const token = (body as { token?: string } | null)?.token
        const session = token !== undefined ? sessionFromToken(token) : null
        if (session === null) {
          this.error = 'Login succeeded but the session token could not be read.'
          return
        }
        this.session = session
        this.password = ''
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: session.token }))
        void this.loadKeys()
      } catch {
        this.error = `Could not reach the LiteLLM server at ${this.serverUrl}. Is it running?`
      } finally {
        this.loading = false
      }
    },

    logout() {
      this.session = null
      this.keys = []
      this.teamNames = {}
      this.keysError = ''
      localStorage.removeItem(STORAGE_KEY)
    },

    async loadKeys() {
      const session = this.session
      if (session === null) return
      this.keysError = ''
      this.keysLoading = true
      try {
        const base = this.serverUrl.replace(/\/+$/, '')
        const auth = { Authorization: `Bearer ${session.api_key}` }
        const [keysResult, teamsResult] = await Promise.allSettled([
          fetch(`${base}/key/list?return_full_object=true&size=100`, { headers: auth }),
          fetch(`${base}/team/list`, { headers: auth }),
        ])
        if (keysResult.status === 'rejected') {
          this.keysError = `Could not reach the LiteLLM server at ${this.serverUrl}. Is it running?`
          return
        }
        const response = keysResult.value
        const body: unknown = await response.json().catch(() => null)
        if (!response.ok) {
          this.keysError = extractErrorMessage(body) ?? `Failed to load keys (HTTP ${response.status})`
          return
        }
        const rows = (body as { keys?: unknown[] } | null)?.keys
        this.keys = Array.isArray(rows)
          ? rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null).map(parseVirtualKey)
          : []
        this.teamNames = {}
        if (teamsResult.status === 'fulfilled' && teamsResult.value.ok) {
          const teams: unknown = await teamsResult.value.json().catch(() => null)
          if (Array.isArray(teams)) {
            this.teamNames = Object.fromEntries(
              teams
                .filter((team): team is { team_id: string; team_alias: string } => {
                  if (typeof team !== 'object' || team === null) return false
                  const candidate = team as Record<string, unknown>
                  return typeof candidate.team_id === 'string' && typeof candidate.team_alias === 'string'
                })
                .map((team) => [team.team_id, team.team_alias]),
            )
          }
        }
        await this.resolveMissingTeamNames(auth, base)
      } catch {
        this.keysError = `Could not reach the LiteLLM server at ${this.serverUrl}. Is it running?`
      } finally {
        this.keysLoading = false
      }
    },

    async resolveMissingTeamNames(auth: Record<string, string>, base: string) {
      const missing = [
        ...new Set(
          this.keys
            .map((key) => key.team_id)
            .filter((teamId): teamId is string => teamId !== null && !(teamId in this.teamNames)),
        ),
      ]
      await Promise.allSettled(
        missing.map(async (teamId) => {
          const response = await fetch(`${base}/team/info?team_id=${encodeURIComponent(teamId)}`, { headers: auth })
          if (!response.ok) return
          const body: unknown = await response.json().catch(() => null)
          const alias = (body as { team_info?: { team_alias?: string } } | null)?.team_info?.team_alias
          if (typeof alias === 'string' && alias !== '') this.teamNames[teamId] = alias
        }),
      )
    },

    teamName(key: VirtualKey): string {
      if (key.team_id === null) return '—'
      return this.teamNames[key.team_id] ?? `${key.team_id.slice(0, 8)}…`
    },

    expiryTime(key: VirtualKey): number | null {
      if (key.expires === null) return null
      const time = new Date(key.expires).getTime()
      return Number.isNaN(time) ? null : time
    },

    keyStatus(key: VirtualKey): string {
      if (key.blocked) return 'blocked'
      const expiry = this.expiryTime(key)
      if (expiry !== null && expiry <= Date.now()) return 'expired'
      return 'active'
    },

    formatExpiry(key: VirtualKey): string {
      const expiry = this.expiryTime(key)
      return expiry === null ? 'Never' : new Date(expiry).toLocaleDateString()
    },

    formatSpend(key: VirtualKey): string {
      return `$${(key.spend ?? 0).toFixed(2)}`
    },

    formatBudget(key: VirtualKey): string {
      return key.max_budget === null ? 'No limit' : `$${key.max_budget.toFixed(2)}`
    },

    async copyValue(value: string) {
      await navigator.clipboard.writeText(value)
      this.copiedValue = value
      setTimeout(() => {
        this.copiedValue = null
      }, 1500)
    },
  }
}
