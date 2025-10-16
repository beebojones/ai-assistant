export type Tokens = {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
  token_type?: string
}

const GOOGLE_OAUTH_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_OAUTH_TOKEN = 'https://oauth2.googleapis.com/token'

const CALENDAR_SCOPE = [
  'https://www.googleapis.com/auth/calendar.events'
].join(' ')

export function getAuthUrl({ clientId, redirectUri, state }: { clientId: string; redirectUri: string; state: string }) {
  const url = new URL(GOOGLE_OAUTH_AUTH)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', CALENDAR_SCOPE)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)
  return url.toString()
}

export async function exchangeCodeForTokens({ code, clientId, clientSecret, redirectUri }: { code: string; clientId: string; clientSecret: string; redirectUri: string }): Promise<Tokens> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  const res = await fetch(GOOGLE_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`)
  return res.json<Tokens>()
}

export async function refreshAccessToken({ refreshToken, clientId, clientSecret }: { refreshToken: string; clientId: string; clientSecret: string }): Promise<{ access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  })
  const res = await fetch(GOOGLE_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`Refresh failed: ${res.status}`)
  const json = await res.json<any>()
  return { access_token: json.access_token, expires_in: json.expires_in }
}

export async function getUserInfo(accessToken: string): Promise<{ email: string; id: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error('Failed to fetch user info')
  const j = await res.json<any>()
  return { email: j.email, id: j.id }
}
