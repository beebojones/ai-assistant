type ParseEventArgs = {
  apiKey: string
  model: string
  userText: string
  nowISO: string
  timeZone?: string
  defaultDurationMinutes?: number
}

export async function parseEventFromText({ apiKey, model, userText, nowISO, timeZone, defaultDurationMinutes }: ParseEventArgs) {
  const sys = `You convert natural language into a Google Calendar event JSON.
- Assume the user's locale and calendar semantics.
- Resolve relative dates/times based on NOW and TIMEZONE.
- If end time missing, set it to start + DEFAULT_DURATION minutes.
- Output ONLY strict JSON matching this TypeScript type (no markdown):
{
  "summary": string,
  "location"?: string,
  "description"?: string,
  "start": { "dateTime": string, "timeZone"?: string },
  "end": { "dateTime": string, "timeZone"?: string },
  "attendees"?: { "email": string }[],
  "reminders"?: { "useDefault"?: boolean, "overrides"?: { "method": "email" | "popup", "minutes": number }[] }
}
Rules: dateTime must be ISO 8601 with timezone offset or Z. If TIMEZONE provided, prefer it in start/end.timeZone.`
  const user = `NOW=${nowISO}\nTIMEZONE=${timeZone || ''}\nDEFAULT_DURATION=${defaultDurationMinutes || 60}\nREQUEST=${userText}`

  const payload = {
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' as const },
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`OpenAI error: ${res.status}`)
  const json = await res.json<any>()
  const content = json.choices?.[0]?.message?.content
  if (!content) throw new Error('No content from OpenAI')
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Model did not return JSON')
  }
  // Minimal sanity checks
  if (!parsed?.summary || !parsed?.start?.dateTime || !parsed?.end?.dateTime) {
    throw new Error('Incomplete event data from model')
  }
  return parsed
}
