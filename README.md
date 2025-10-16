# AI Assistant Backend (Cloudflare Workers + Google Calendar)

This backend is a free-tier friendly Cloudflare Workers service that handles Google OAuth and Calendar actions. It stores tokens in Cloudflare D1.

## Stack
- Cloudflare Workers + Hono (router)
- Cloudflare D1 (SQLite) for token storage
- Google OAuth2 + Calendar API

## Endpoints
- GET `/auth/google` → Redirect to Google consent
- GET `/oauth2/callback` → Handle OAuth callback, store tokens, set session cookie
- GET `/api/calendar/events` → List primary calendar events
- POST `/api/calendar/events` → Create an event in primary calendar
- POST `/api/assistant/schedule` → Natural language scheduling via ChatGPT (OpenAI)

## Setup
1) Create Google OAuth credentials
- Create a project in Google Cloud Console
- Enable "Google Calendar API"
- Configure OAuth consent screen (External)
- Create OAuth Client ID (Web application)
  - Authorized redirect URIs (add both for dev and prod):
    - http://localhost:8787/oauth2/callback
    - https://<your-worker-subdomain>/oauth2/callback

2) Cloudflare setup
- Install Node.js 18+ and `npm i -g wrangler`
- Authenticate: `wrangler login`
- Create D1: `wrangler d1 create ai_assistant_db` and update `wrangler.toml`'s `database_id`
- Apply schema: `wrangler d1 execute ai_assistant_db --file=schema.sql`
- Set secrets:
  - `wrangler secret put GOOGLE_CLIENT_ID`
  - `wrangler secret put GOOGLE_CLIENT_SECRET`
  - `wrangler secret put SESSION_SECRET` (random string for cookie integrity)
  - `wrangler secret put OPENAI_API_KEY`

3) Dev
- `npm install`
- `wrangler dev`
- Visit `http://localhost:8787/auth/google`

4) Deploy
- `wrangler deploy`
- Add your production callback URL to Google OAuth credentials if not already added

## Notes
- Free tier: Workers and D1 both have free allowances suitable for MVP.
- OpenAI usage is paid; choose a small model (default `gpt-4o-mini`) to minimize cost.
- Scopes are limited to Calendar for now; expand later as needed.
