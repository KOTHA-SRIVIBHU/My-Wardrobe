// Dates are calendar days as 'YYYY-MM-DD' strings (compare with < and >); timestamps are
// ISO strings in UTC.

let last = 0

/** Current time as an ISO string, strictly increasing so history keeps its order. */
export function clock(): string {
  let now = Date.now()
  if (now <= last) now = last + 1
  last = now
  return new Date(now).toISOString()
}

/** The device's local calendar date. */
export function localToday(): string {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

function utc(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function addDays(iso: string, n: number): string {
  const d = utc(iso)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000)
}

/** 0 = Monday ... 6 = Sunday (like Python's date.weekday()). */
export function weekday(iso: string): number {
  return (utc(iso).getUTCDay() + 6) % 7
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Tue 8 Jan" */
export function dayLabel(iso: string): string {
  const d = utc(iso)
  return `${SHORT_DAYS[weekday(iso)]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/** "Tue 08 Jan" (zero-padded day, as Python's %a %d %b) */
export function dayLabelPadded(iso: string): string {
  const d = utc(iso)
  return `${SHORT_DAYS[weekday(iso)]} ${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`
}

export const minDate = (a: string, b: string) => (a < b ? a : b)
export const maxDate = (a: string, b: string) => (a > b ? a : b)

/** Calendar date (UTC) of an ISO timestamp. */
export const dateOf = (timestamp: string) => timestamp.slice(0, 10)

export function* dateRange(start: string, end: string): Generator<string> {
  for (let d = start; d <= end; d = addDays(d, 1)) yield d
}
