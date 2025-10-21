export type UserRow = {
  id: string
  email: string
  google_refresh_token: string
  google_access_token?: string | null
  google_access_token_expires_at?: number | null
}

export async function getUserByEmail(DB: D1Database, email: string): Promise<UserRow | null> {
  const res = await DB.prepare(
    'SELECT id, email, google_refresh_token, google_access_token, google_access_token_expires_at FROM users WHERE email = ?'
  )
    .bind(email)
    .first<UserRow>()
  return (res as any) ?? null
}

export async function upsertUserByEmail(
  DB: D1Database,
  email: string,
  tokens: { refresh_token: string; access_token: string; expires_in: number }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + (tokens.expires_in || 3600)
  const id = crypto.randomUUID()
  // Use SQLite UPSERT to avoid UNIQUE conflicts on email
  await DB.prepare(
    `INSERT INTO users (id, email, google_refresh_token, google_access_token, google_access_token_expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       google_refresh_token = excluded.google_refresh_token,
       google_access_token = excluded.google_access_token,
       google_access_token_expires_at = excluded.google_access_token_expires_at`
  )
    .bind(id, email, tokens.refresh_token, tokens.access_token, expiresAt)
    .run()
}
