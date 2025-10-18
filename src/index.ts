import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { getAuthUrl, exchangeCodeForTokens, refreshAccessToken, getUserInfo, type Tokens } from './google'
import { getUserByEmail, upsertUserByEmail } from './storage'
import { listEvents, createEvent } from './calendar'
import { parseEventFromText } from './ai'

export type Bindings = {
  DB: D1Database
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  SESSION_SECRET: string
  OAUTH_REDIRECT_PATH?: string
  OPENAI_API_KEY: string
  OPENAI_MODEL?: string
}

const app = new Hono<{ Bindings: Bindings }>()

function randomState(): string {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return btoa(String.fromCharCode(...a)).replace(/\W/g, '')
}

function getCookie(req: Request, name: string): string | undefined {
  const cookie = req.headers.get('cookie')
  if (!cookie) return undefined
  const parts = cookie.split(';').map((c) => c.trim())
  for (const p of parts) {
    const [k, ...rest] = p.split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

function buildCookie(name: string, value: string, opts: { httpOnly?: boolean; secure?: boolean; path?: string; maxAge?: number } = {}) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? '/'}`,
    opts.httpOnly ? 'HttpOnly' : '',
    (opts.secure ?? true) ? 'Secure' : '',
    opts.maxAge ? `Max-Age=${opts.maxAge}` : '',
    'SameSite=Lax',
  ].filter(Boolean)
  return attrs.join('; ')
}

app.get('/auth/google', async (c) => {
  const { GOOGLE_CLIENT_ID } = env(c)
  const redirectPath = env(c).OAUTH_REDIRECT_PATH || '/oauth2/callback'
  const state = randomState()
  const origin = new URL(c.req.url).origin
  const redirectUri = `${origin}${redirectPath}`
  const url = getAuthUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri, state })
  const res = c.redirect(url)
  res.headers.append('Set-Cookie', buildCookie('oauth_state', state, { httpOnly: true, secure: true, path: '/', maxAge: 600 }))
  return res
})

app.get('/oauth2/callback', async (c) => {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, DB } = env(c)
  const url = new URL(c.req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const stateCookie = getCookie(c.req.raw, 'oauth_state')
  if (!code || !state || !stateCookie || state !== stateCookie) {
    return c.text('Invalid OAuth state', 400)
  }
  const origin = new URL(c.req.url).origin
  const redirectUri = `${origin}${env(c).OAUTH_REDIRECT_PATH || '/oauth2/callback'}`
  const tokens = await exchangeCodeForTokens({
    code,
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri,
  })
  const userinfo = await getUserInfo(tokens.access_token)
  await upsertUserByEmail(DB, userinfo.email, {
    refresh_token: tokens.refresh_token!,
    access_token: tokens.access_token,
    expires_in: tokens.expires_in,
  })
  const res = c.text('Authenticated. You can now call /api/calendar endpoints.', 200)
  res.headers.append('Set-Cookie', buildCookie('uid', userinfo.email, { httpOnly: true, secure: true, path: '/', maxAge: 60 * 60 * 24 * 30 }))
  res.headers.append('Set-Cookie', buildCookie('oauth_state', '', { httpOnly: true, secure: true, path: '/', maxAge: 0 }))
  return res
})

async function getValidAccessToken(DB: D1Database, email: string, clientId: string, clientSecret: string): Promise<string | null> {
  const user = await getUserByEmail(DB, email)
  if (!user) return null
  const now = Math.floor(Date.now() / 1000)
  if (user.google_access_token && user.google_access_token_expires_at && user.google_access_token_expires_at - 60 > now) {
    return user.google_access_token
  }
  const refreshed = await refreshAccessToken({ refreshToken: user.google_refresh_token, clientId, clientSecret })
  await upsertUserByEmail(DB, email, { refresh_token: user.google_refresh_token, access_token: refreshed.access_token, expires_in: refreshed.expires_in })
  return refreshed.access_token
}

app.get('/api/calendar/events', async (c) => {
  const { DB, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env(c)
  const uid = getCookie(c.req.raw, 'uid')
  if (!uid) return c.text('Unauthorized', 401)
  const accessToken = await getValidAccessToken(DB, uid, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
  if (!accessToken) return c.text('No tokens. Re-auth at /auth/google', 401)
  const { searchParams } = new URL(c.req.url)
  const timeMin = searchParams.get('timeMin') || new Date().toISOString()
  const timeMax = searchParams.get('timeMax') || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
  const events = await listEvents(accessToken, { timeMin, timeMax })
  return c.json(events)
})

app.post('/api/calendar/events', async (c) => {
  const { DB, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env(c)
  const uid = getCookie(c.req.raw, 'uid')
  if (!uid) return c.text('Unauthorized', 401)
  const accessToken = await getValidAccessToken(DB, uid, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
  if (!accessToken) return c.text('No tokens. Re-auth at /auth/google', 401)
  const body = await c.req.json()
  const created = await createEvent(accessToken, body)
  return c.json(created)
})

app.post('/api/assistant/schedule', async (c) => {
  const { DB, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OPENAI_API_KEY, OPENAI_MODEL } = env(c)
  const uid = getCookie(c.req.raw, 'uid')
  if (!uid) return c.text('Unauthorized', 401)
  const accessToken = await getValidAccessToken(DB, uid, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
  if (!accessToken) return c.text('No tokens. Re-auth at /auth/google', 401)
  const { query, timeZone, defaultDurationMinutes } = await c.req.json<{ query: string; timeZone?: string; defaultDurationMinutes?: number }>()
  if (!query) return c.text('Missing query', 400)
  const nowISO = new Date().toISOString()
  const eventInput = await parseEventFromText({
    apiKey: OPENAI_API_KEY,
    model: OPENAI_MODEL || 'gpt-4o-mini',
    userText: query,
    nowISO,
    timeZone,
    defaultDurationMinutes,
  })
  const created = await createEvent(accessToken, eventInput)
  return c.json(created)
})

export default app
