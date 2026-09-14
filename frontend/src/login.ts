const STORAGE_KEY = 'litellm_session'

const SERVER_URL = String(import.meta.env.VITE_LITELLM_URL ?? 'http://localhost:4000').replace(/\/+$/, '')

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
  user_id: string | null
  team_id: string | null
  organization_id: string | null
  spend: number | null
  soft_budget: number | null
  max_budget: number | null
  budget_duration: string | null
  expires: string | null
  blocked: boolean | null
  models: string[] | null
  aliases: Record<string, string> | null
  config: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  permissions: Record<string, unknown> | null
  budget_fallbacks: Record<string, string[]> | null
  model_max_budget: Record<string, unknown> | null
  allowed_cache_controls: string[] | null
  allowed_routes: string[] | null
  key_type: string | null
  tpm_limit: number | null
  rpm_limit: number | null
  max_parallel_requests: number | null
  model_tpm_limit: Record<string, number> | null
  model_rpm_limit: Record<string, number> | null
}

type RegenStage = 'confirm' | 'working' | 'done'

type View = 'keys' | 'teams'

interface Team {
  team_id: string
  team_alias: string
  key_count: number | null
  member_budget: number | null
  spend: number | null
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

function optionalString(raw: Record<string, unknown>, field: string): string | null {
  return typeof raw[field] === 'string' ? (raw[field] as string) : null
}

function optionalNumber(raw: Record<string, unknown>, field: string): number | null {
  return typeof raw[field] === 'number' ? (raw[field] as number) : null
}

function optionalRecord(raw: Record<string, unknown>, field: string): Record<string, unknown> | null {
  const value = raw[field]
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function optionalStringArray(raw: Record<string, unknown>, field: string): string[] | null {
  const value = raw[field]
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null
}

function parseVirtualKey(raw: Record<string, unknown>): VirtualKey {
  return {
    token: String(raw.token ?? ''),
    key_name: optionalString(raw, 'key_name'),
    key_alias: optionalString(raw, 'key_alias'),
    user_id: optionalString(raw, 'user_id'),
    team_id: optionalString(raw, 'team_id'),
    organization_id: optionalString(raw, 'organization_id'),
    spend: optionalNumber(raw, 'spend'),
    soft_budget: optionalNumber(raw, 'soft_budget'),
    max_budget: optionalNumber(raw, 'max_budget'),
    budget_duration: optionalString(raw, 'budget_duration'),
    expires: optionalString(raw, 'expires'),
    blocked: raw.blocked === true,
    models: optionalStringArray(raw, 'models'),
    aliases: optionalRecord(raw, 'aliases') as Record<string, string> | null,
    config: optionalRecord(raw, 'config'),
    metadata: optionalRecord(raw, 'metadata'),
    permissions: optionalRecord(raw, 'permissions'),
    budget_fallbacks: optionalRecord(raw, 'budget_fallbacks') as Record<string, string[]> | null,
    model_max_budget: optionalRecord(raw, 'model_max_budget'),
    allowed_cache_controls: optionalStringArray(raw, 'allowed_cache_controls'),
    allowed_routes: optionalStringArray(raw, 'allowed_routes'),
    key_type: optionalString(raw, 'key_type'),
    tpm_limit: optionalNumber(raw, 'tpm_limit'),
    rpm_limit: optionalNumber(raw, 'rpm_limit'),
    max_parallel_requests: optionalNumber(raw, 'max_parallel_requests'),
    model_tpm_limit: optionalRecord(raw, 'model_tpm_limit') as Record<string, number> | null,
    model_rpm_limit: optionalRecord(raw, 'model_rpm_limit') as Record<string, number> | null,
  }
}

export function loginForm() {
  return {
    serverUrl: SERVER_URL,
    username: '',
    password: '',
    loading: false,
    error: '',
    copiedValue: null as string | null,
    session: null as Session | null,

    keys: [] as VirtualKey[],
    teamNames: {} as Record<string, string>,
    userAlias: '',
    keysLoading: false,
    keysError: '',

    teams: [] as Team[],
    view: 'keys' as View,
    teamsLoading: false,
    teamsError: '',

    regenKey: null as VirtualKey | null,
    regenStage: 'confirm' as RegenStage,
    regenError: '',
    regenWarning: '',
    newKeyValue: '',

    get isAdmin(): boolean {
      return this.session !== null && this.session.user_role !== 'internal_user'
    },

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
        void this.loadUserAlias()
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
        void this.loadUserAlias()
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
      this.userAlias = ''
      this.keysError = ''
      this.teams = []
      this.teamsError = ''
      this.view = 'keys'
      this.closeRegenModal()
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

    showTeams() {
      this.view = 'teams'
      if (this.teams.length === 0 || this.teamsError !== '') void this.loadTeams()
    },

    async loadTeams() {
      const session = this.session
      if (session === null) return
      this.teamsError = ''
      this.teamsLoading = true
      try {
        const base = this.serverUrl.replace(/\/+$/, '')
        const auth = { Authorization: `Bearer ${session.api_key}` }
        const response = await fetch(`${base}/team/list`, { headers: auth })
        const body: unknown = await response.json().catch(() => null)
        if (!response.ok) {
          this.teamsError = extractErrorMessage(body) ?? `Failed to load teams (HTTP ${response.status})`
          return
        }
        const rows = Array.isArray(body) ? body : []
        const listed = rows
          .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
          .map((row) => ({
            team_id: String(row.team_id ?? ''),
            team_alias: optionalString(row, 'team_alias') ?? '',
          }))
        const stats = await Promise.allSettled(
          listed.map((team) => this.fetchTeamStats(auth, base, team.team_id)),
        )
        this.teams = listed
          .map((team, index): Team => {
            const stat = stats[index]
            const info = stat.status === 'fulfilled' ? stat.value : null
            return {
              team_id: team.team_id,
              team_alias: team.team_alias,
              key_count: info?.key_count ?? null,
              member_budget: info?.member_budget ?? null,
              spend: info?.spend ?? null,
            }
          })
          .sort((a, b) => a.team_alias.localeCompare(b.team_alias))
      } catch {
        this.teamsError = `Could not reach the LiteLLM server at ${this.serverUrl}. Is it running?`
      } finally {
        this.teamsLoading = false
      }
    },

    async fetchTeamStats(
      auth: Record<string, string>,
      base: string,
      teamId: string,
    ): Promise<{ key_count: number | null; member_budget: number | null; spend: number | null } | null> {
      const response = await fetch(`${base}/team/info?team_id=${encodeURIComponent(teamId)}`, { headers: auth })
      if (!response.ok) return null
      const body: unknown = await response.json().catch(() => null)
      const info = body as { team_info?: Record<string, unknown>; keys?: unknown[] } | null
      if (info === null || typeof info.team_info !== 'object' || info.team_info === null) return null
      const budgetTable = info.team_info.team_member_budget_table
      const rawBudget = typeof budgetTable === 'object' && budgetTable !== null ? (budgetTable as Record<string, unknown>).max_budget : undefined
      return {
        key_count: Array.isArray(info.keys) ? info.keys.length : null,
        member_budget: typeof rawBudget === 'number' ? rawBudget : null,
        spend: optionalNumber(info.team_info, 'spend'),
      }
    },

    async loadUserAlias() {
      const session = this.session
      if (session === null) return
      try {
        const base = this.serverUrl.replace(/\/+$/, '')
        const response = await fetch(`${base}/user/info?user_id=${encodeURIComponent(session.user_id)}`, {
          headers: { Authorization: `Bearer ${session.api_key}` },
        })
        if (!response.ok) return
        const body: unknown = await response.json().catch(() => null)
        const alias = (body as { user_info?: { user_alias?: string } } | null)?.user_info?.user_alias
        if (typeof alias === 'string' && alias !== '') this.userAlias = alias
      } catch {
        // best-effort: fall back to email/user_id in the header
      }
    },

    teamName(key: VirtualKey): string {
      if (key.team_id === null) return '—'
      return this.teamNames[key.team_id] ?? `${key.team_id.slice(0, 8)}…`
    },

    teamKeyCount(team: Team): string {
      return team.key_count === null ? '—' : String(team.key_count)
    },

    teamMemberBudget(team: Team): string {
      return team.member_budget === null ? '—' : this.formatUsd(team.member_budget)
    },

    teamSpend(team: Team): string {
      return team.spend === null ? '—' : this.formatUsd(team.spend)
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
      return this.formatUsd(key.spend ?? 0)
    },

    formatBudget(key: VirtualKey): string {
      return key.max_budget === null ? 'No limit' : this.formatUsd(key.max_budget)
    },

    formatUsd(value: number): string {
      if (value > 0 && value < 0.0000005) return '<$0.000001'
      let text = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
      if (!text.includes('.')) text += '.00'
      else if (text.split('.')[1].length < 2) text += '0'
      return `$${text}`
    },

    async copyValue(value: string) {
      await navigator.clipboard.writeText(value)
      this.copiedValue = value
      setTimeout(() => {
        this.copiedValue = null
      }, 1500)
    },

    openRegenModal(key: VirtualKey) {
      this.regenKey = key
      this.regenStage = 'confirm'
      this.regenError = ''
      this.regenWarning = ''
      this.newKeyValue = ''
    },

    closeRegenModal() {
      if (this.regenStage === 'working') return
      const wasDone = this.regenStage === 'done'
      this.regenKey = null
      if (wasDone) void this.loadKeys()
    },

    buildRegenPayload(key: VirtualKey, session: Session): Record<string, unknown> {
      const payload: Record<string, unknown> = {}
      const isAdmin = session.user_role !== 'internal_user'
      if (key.key_alias !== null) payload.key_alias = key.key_alias
      if (isAdmin && key.user_id !== null) payload.user_id = key.user_id
      if (key.team_id !== null) payload.team_id = key.team_id
      if (isAdmin && key.organization_id !== null) payload.organization_id = key.organization_id
      if (key.spend !== null && key.spend > 0) payload.spend = key.spend
      if (key.soft_budget !== null) payload.soft_budget = key.soft_budget
      if (key.max_budget !== null) payload.max_budget = key.max_budget
      if (key.budget_duration !== null) payload.budget_duration = key.budget_duration
      if (key.models !== null && key.models.length > 0) payload.models = key.models
      if (key.aliases !== null && Object.keys(key.aliases).length > 0) payload.aliases = key.aliases
      if (key.config !== null && Object.keys(key.config).length > 0) payload.config = key.config
      if (key.metadata !== null && Object.keys(key.metadata).length > 0) payload.metadata = key.metadata
      if (key.permissions !== null && Object.keys(key.permissions).length > 0) payload.permissions = key.permissions
      if (key.budget_fallbacks !== null && Object.keys(key.budget_fallbacks).length > 0)
        payload.budget_fallbacks = key.budget_fallbacks
      if (key.model_max_budget !== null && Object.keys(key.model_max_budget).length > 0)
        payload.model_max_budget = key.model_max_budget
      if (key.allowed_cache_controls !== null && key.allowed_cache_controls.length > 0)
        payload.allowed_cache_controls = key.allowed_cache_controls
      if (key.key_type !== null) payload.key_type = key.key_type
      // `allowed_routes` is proxy-admin-only; internal users reproduce routes via the `key_type` preset instead.
      if (isAdmin && key.allowed_routes !== null && key.allowed_routes.length > 0)
        payload.allowed_routes = key.allowed_routes
      if (key.tpm_limit !== null) payload.tpm_limit = key.tpm_limit
      if (key.rpm_limit !== null) payload.rpm_limit = key.rpm_limit
      if (key.max_parallel_requests !== null) payload.max_parallel_requests = key.max_parallel_requests
      if (key.model_tpm_limit !== null && Object.keys(key.model_tpm_limit).length > 0)
        payload.model_tpm_limit = key.model_tpm_limit
      if (key.model_rpm_limit !== null && Object.keys(key.model_rpm_limit).length > 0)
        payload.model_rpm_limit = key.model_rpm_limit
      if (key.blocked === true) payload.blocked = true
      const expiry = this.expiryTime(key)
      if (expiry !== null && expiry > Date.now()) {
        const seconds = Math.max(1, Math.round((expiry - Date.now()) / 1000))
        payload.duration = `${seconds}s`
      }
      return payload
    },

    async confirmRegenerate() {
      const key = this.regenKey
      const session = this.session
      if (key === null || session === null || this.regenStage === 'working') return
      this.regenStage = 'working'
      this.regenError = ''
      this.regenWarning = ''
      const base = this.serverUrl.replace(/\/+$/, '')
      const auth = { Authorization: `Bearer ${session.api_key}`, 'Content-Type': 'application/json' }
      try {
        // Aliases are globally unique on LiteLLM, so the old key must be deleted
        // before the replacement can take its name.
        let revokeWarning = ''
        const revoke = await fetch(`${base}/key/delete`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ keys: [key.token] }),
        })
        if (!revoke.ok) {
          const revokeBody: unknown = await revoke.json().catch(() => null)
          const message = extractErrorMessage(revokeBody) ?? `HTTP ${revoke.status}`
          // 404 "No keys found" means the key is already gone (e.g. a retry) — the desired state.
          if (revoke.status !== 404) revokeWarning = message
        }

        const payload = this.buildRegenPayload(key, session)
        const generate = await fetch(`${base}/key/generate`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify(payload),
        })
        const generateBody: unknown = await generate.json().catch(() => null)
        const newKey = (generateBody as { key?: string } | null)?.key
        if (!generate.ok || typeof newKey !== 'string') {
          const message = extractErrorMessage(generateBody) ?? `Regeneration failed (HTTP ${generate.status})`
          this.regenError =
            revokeWarning === ''
              ? `The previous key was deleted, but creating the replacement failed: ${message}`
              : `Regeneration failed: ${message} (the previous key could not be deleted either: ${revokeWarning})`
          this.regenStage = 'confirm'
          return
        }
        this.newKeyValue = newKey
        if (revokeWarning !== '') {
          this.regenWarning = `The new key was created but the old key could not be deleted: ${revokeWarning}`
        }
        this.regenStage = 'done'
      } catch {
        this.regenError = `Could not reach the LiteLLM server at ${this.serverUrl}. Is it running? The previous key may already be deleted.`
        this.regenStage = 'confirm'
      }
    },
  }
}
