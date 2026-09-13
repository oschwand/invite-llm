const STORAGE_KEY = 'litellm_session'

interface Session {
  token: string
  user_id: string
  user_email: string
  user_role: string
  expires_at: number
}

interface ErrorBody {
  error?: { message?: string }
  detail?: { message?: string } | string
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
    user_id: String(payload.user_id ?? 'unknown'),
    user_email: String(payload.user_email ?? ''),
    user_role: String(payload.user_role ?? ''),
    expires_at: payload.exp,
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const data = body as ErrorBody
  if (typeof data.error?.message === 'string') return data.error.message
  if (typeof data.detail === 'string') return data.detail
  if (typeof data.detail?.message === 'string') return data.detail.message
  if (typeof data.message === 'string') return data.message
  return null
}

export function loginForm() {
  return {
    serverUrl: 'http://localhost:4000',
    username: '',
    password: '',
    loading: false,
    error: '',
    copied: false,
    session: null as Session | null,

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
      } catch {
        this.error = `Could not reach the LiteLLM server at ${this.serverUrl}. Is it running?`
      } finally {
        this.loading = false
      }
    },

    logout() {
      this.session = null
      localStorage.removeItem(STORAGE_KEY)
    },

    async copyToken() {
      if (this.session === null) return
      await navigator.clipboard.writeText(this.session.token)
      this.copied = true
      setTimeout(() => {
        this.copied = false
      }, 1500)
    },
  }
}
