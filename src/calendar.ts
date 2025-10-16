import type { CalendarEventInput } from './types'

export async function listEvents(accessToken: string, { timeMin, timeMax }: { timeMin: string; timeMax: string }) {
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('timeMin', timeMin)
  url.searchParams.set('timeMax', timeMax)
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Failed to list events: ${res.status}`)
  return res.json<any>()
}

export async function createEvent(accessToken: string, input: CalendarEventInput) {
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Failed to create event: ${res.status}`)
  return res.json<any>()
}
