export type CalendarEventInput = {
  summary: string
  location?: string
  description?: string
  start: { dateTime: string; timeZone?: string }
  end: { dateTime: string; timeZone?: string }
  attendees?: { email: string }[]
  reminders?: {
    useDefault?: boolean
    overrides?: { method: 'email' | 'popup'; minutes: number }[]
  }
}
