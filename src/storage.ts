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
  const existing = await getUserByEmail(DB, email)
  if (existing) {
    await DB.prepare(
      'UPDATE users SET google_refresh_token = ?, google_access_token = ?, google_access_token_expires_at = ? WHERE email = ?'
    )
      .bind(tokens.refresh_token || existing.google_refresh_token, tokens.access_token, expiresAt, email)
      .run()
  } else {
    const id = crypto.randomUUID()
    await DB.prepare(
      'INSERT INTO users (id, email, google_refresh_token, google_access_token, google_access_token_expires_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(id, email, tokens.refresh_token, tokens.access_token, expiresAt)
      .run()
  }
}
