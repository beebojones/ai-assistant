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
  // Handle case where Google does not return a refresh_token (happens after first consent)
  const existing = await getUserByEmail(DB, userinfo.email)
  const refreshToken = tokens.refresh_token || existing?.google_refresh_token
  if (!refreshToken) {
    return c.text('No refresh token. Remove app access at myaccount.google.com/permissions and retry.', 400)
  }
  await upsertUserByEmail(DB, userinfo.email, {
    refresh_token: refreshToken,
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

app.get('/', async (c) => {
  const uid = getCookie(c.req.raw, 'uid')
  const html = `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI Assistant • Calendar</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
      body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"; }
      .glass { backdrop-filter: blur(8px); background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); }
      .gradient { background: radial-gradient(1200px 600px at 10% 0%, #60a5fa22, transparent), radial-gradient(1000px 500px at 100% 0%, #f472b622, transparent), radial-gradient(800px 400px at 50% 100%, #34d39922, transparent); }
    </style>
  </head>
  <body class="min-h-screen gradient text-slate-100">
    <header class="px-6 py-4 flex items-center justify-between">
      <div class="text-xl font-semibold">AI Assistant</div>
      <div class="space-x-2">
        ${uid ? `<span class="text-sm opacity-80">Signed in as ${uid}</span>` : ''}
        <a href="/auth/google" class="px-3 py-2 rounded-md bg-blue-500 hover:bg-blue-600 text-white">${uid ? 'Re-connect Google' : 'Connect Google'}</a>
        ${uid ? '<a href="/logout" class="px-3 py-2 rounded-md bg-slate-700 hover:bg-slate-600">Logout</a>' : ''}
      </div>
    </header>

    <main class="max-w-5xl mx-auto p-6 grid gap-6 md:grid-cols-2">
      <section class="glass rounded-xl p-6">
        <h2 class="font-semibold text-lg mb-3">Natural-language scheduling</h2>
        <label class="block text-sm mb-2">What should I schedule?</label>
        <textarea id="query" rows="5" class="w-full rounded-md bg-slate-900/60 border border-slate-700 p-3" placeholder="Dinner with Sam Friday at 7pm for 90 minutes at Bistro"></textarea>
        <div class="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label class="block text-sm mb-1">Time zone</label>
            <input id="tz" class="w-full rounded-md bg-slate-900/60 border border-slate-700 p-2" />
          </div>
          <div>
            <label class="block text-sm mb-1">Default duration (minutes)</label>
            <input id="dur" type="number" value="60" class="w-full rounded-md bg-slate-900/60 border border-slate-700 p-2" />
          </div>
        </div>
        <button id="schedule" class="mt-4 px-4 py-2 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white">Create event</button>
        <pre id="result" class="mt-4 text-xs whitespace-pre-wrap"></pre>
      </section>

      <section class="glass rounded-xl p-6">
        <h2 class="font-semibold text-lg mb-3">Upcoming week</h2>
        <div class="flex items-center gap-2 mb-3">
          <button id="loadEvents" class="px-3 py-2 rounded-md bg-purple-500 hover:bg-purple-600 text-white">Refresh</button>
          <span id="status" class="text-xs opacity-75"></span>
        </div>
        <ul id="events" class="space-y-2 text-sm"></ul>
      </section>
    </main>

    <script>
      const tzInput = document.getElementById('tz');
      tzInput.value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

      const fmt = (ev) => {
        const s = ev.start?.dateTime || ev.start?.date;
        const e = ev.end?.dateTime || ev.end?.date;
        return `${new Date(s).toLocaleString()} → ${new Date(e).toLocaleTimeString()} — ${ev.summary || '(no title)'}`
      }

      document.getElementById('loadEvents').onclick = async () => {
        const status = document.getElementById('status');
        status.textContent = 'Loading...';
        try {
          const res = await fetch('/api/calendar/events');
          if (!res.ok) throw new Error('Failed to fetch events');
          const j = await res.json();
          const list = document.getElementById('events');
          list.innerHTML = '';
          (j.items || []).forEach(ev => {
            const li = document.createElement('li');
            li.className = 'p-3 rounded-md bg-slate-900/50 border border-slate-700';
            li.textContent = fmt(ev);
            list.appendChild(li);
          });
          status.textContent = '';
        } catch (e) {
          status.textContent = e.message;
        }
      };

      document.getElementById('schedule').onclick = async () => {
        const query = (document.getElementById('query').value || '').trim();
        const timeZone = tzInput.value || 'UTC';
        const defaultDurationMinutes = parseInt(document.getElementById('dur').value || '60', 10);
        const out = document.getElementById('result');
        out.textContent = 'Scheduling...';
        try {
          const res = await fetch('/api/assistant/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, timeZone, defaultDurationMinutes })
          });
          const j = await res.json();
          out.textContent = JSON.stringify(j, null, 2);
          // refresh list
          document.getElementById('loadEvents').click();
        } catch (e) {
          out.textContent = e.message;
        }
      };

      // Auto-load events on open
      document.getElementById('loadEvents').click();
    </script>
  </body>
  </html>`
  return c.html(html)
})

app.get('/api/me', (c) => {
  const uid = getCookie(c.req.raw, 'uid')
  if (!uid) return c.text('Unauthorized', 401)
  return c.json({ email: uid })
})

app.get('/logout', (c) => {
  const res = c.redirect('/')
  res.headers.append('Set-Cookie', buildCookie('uid', '', { path: '/', maxAge: 0, httpOnly: true, secure: true }))
  return res
})

// Fallback: serve UI for any unknown route
app.all('*', (c) => c.redirect('/'))

export default app
