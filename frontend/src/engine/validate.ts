// Input validation (what the server's request schemas used to do). Errors are 422s
// with a readable message.
import type { CalendarEventInput, GarmentState, IroningPolicy, Requirement, RoutineInput, Settings } from '../lib/types'
import { invalid } from './errors'
import { cleanTags } from './vocab'

export const IRONING_POLICIES: IroningPolicy[] = ['not_required', 'required', 'optional', 'user_decides']
export const GARMENT_STATES: GarmentState[] = ['ready', 'worn_reusable', 'needs_laundry', 'in_basket', 'in_laundry', 'drying', 'needs_ironing', 'reserved', 'unavailable']
export const EVENT_KINDS = ['office', 'college', 'holiday', 'party', 'interview', 'wedding', 'travel', 'gym', 'custom']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function str(v: unknown, field: string, o: { min?: number; max?: number; nullable?: boolean } = {}): string | null {
  if (v === null || v === undefined || v === '') {
    if (o.nullable !== false && !o.min) return null
    throw invalid(`${field} is required`)
  }
  if (typeof v !== 'string') throw invalid(`${field} must be text`)
  const t = v.trim()
  if (o.min && t.length < o.min) throw invalid(`${field} is required`)
  if (o.max && t.length > o.max) throw invalid(`${field} is too long (max ${o.max})`)
  return t || null
}

export const required = (v: unknown, field: string, max: number) => str(v, field, { min: 1, max, nullable: false })!

export function int(v: unknown, field: string, min: number, max: number): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${field} must be a whole number from ${min} to ${max}`)
  return n
}

export function dateStr(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw invalid(`${field} must be a date`)
  return v
}

export function timestamp(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null
  const t = Date.parse(String(v))
  if (Number.isNaN(t)) throw invalid(`${field} must be a date and time`)
  return new Date(t).toISOString()
}

export function price(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n >= 1e8) throw invalid('Price must be a positive number')
  return Math.round(n * 100) / 100
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(v as T)) throw invalid(`${field} must be one of: ${allowed.join(', ')}`)
  return v as T
}

export const tags = cleanTags

export function ids(v: unknown, field: string, o: { min?: number; max?: number } = {}): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw invalid(`${field} must be a list`)
  const unique = [...new Set(v as string[])]
  if (o.min !== undefined && unique.length < o.min) throw invalid(`Choose at least ${o.min} ${o.min === 1 ? 'item' : 'items'}`)
  if (o.max !== undefined && unique.length > o.max) throw invalid(`Choose at most ${o.max}`)
  return unique
}

export function weekdays(v: unknown, field = 'weekdays'): number[] {
  if (!Array.isArray(v)) throw invalid(`${field} must be a list`)
  if (v.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw invalid('weekdays are 0 (Monday) to 6 (Sunday)')
  return [...new Set(v as number[])].sort((a, b) => a - b)
}

export function requirement(v: unknown): Requirement {
  const r = (v ?? {}) as Record<string, unknown>
  return {
    category: required(r.category, 'Category', 40).toLowerCase(),
    quantity: int(r.quantity ?? 1, 'Quantity', 1, 10) ?? 1,
    labels: tags(r.labels ?? []),
    min_formality: int(r.min_formality, 'Minimum formality', 1, 5),
    reuse: r.reuse === 'fixed' ? 'fixed' : 'rotate',
    no_consecutive: r.no_consecutive === true,
  }
}

export function routineInput(v: RoutineInput): RoutineInput {
  const days = weekdays(v.weekdays)
  if (!days.length) throw invalid('Pick at least one day')
  if (!Array.isArray(v.requirements) || v.requirements.length < 1) throw invalid('Add at least one item')
  if (v.requirements.length > 15) throw invalid('At most 15 items per routine')
  const start = dateStr(v.start_date, 'From')
  const end = dateStr(v.end_date, 'Until')
  if (start && end && end < start) throw invalid('end_date must be on or after start_date')
  return {
    name: required(v.name, 'Name', 120),
    kind: v.kind === 'night' ? 'night' : 'day',
    weekdays: days,
    start_date: start,
    end_date: end,
    occasion: str(v.occasion, 'Occasion', { max: 60 }),
    formality: int(v.formality, 'Formality', 1, 5),
    requirements: v.requirements.map(requirement),
    mandatory: v.mandatory !== false,
    active: v.active !== false,
    notes: str(v.notes, 'Notes', { max: 2000 }),
    source_text: str(v.source_text, 'Source text', { max: 2000 }),
  }
}

export function eventInput(v: CalendarEventInput): CalendarEventInput {
  const time = (t: unknown, f: string) => {
    if (t === null || t === undefined || t === '') return null
    if (typeof t !== 'string' || !TIME_RE.test(t)) throw invalid(`${f} must be a time like 09:30`)
    return t
  }
  const date = dateStr(v.date, 'Date')
  if (!date) throw invalid('Date is required')
  return {
    title: required(v.title, 'Title', 120),
    kind: oneOf(v.kind ?? 'custom', EVENT_KINDS, 'Kind') as CalendarEventInput['kind'],
    date,
    start_time: time(v.start_time, 'From'),
    end_time: time(v.end_time, 'To'),
    occasion: str(v.occasion, 'Occasion', { max: 60 }),
    formality: int(v.formality, 'Formality', 1, 5),
    labels: tags(v.labels ?? []),
    notes: str(v.notes, 'Notes', { max: 2000 }),
    skip_day_routines: v.skip_day_routines ?? null,
    garment_ids: ids(v.garment_ids ?? [], 'Garments', { max: 20 }),
  }
}

export function settingsInput(v: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {}
  if ('location_name' in v) out.location_name = str(v.location_name, 'Location', { max: 120 })
  if ('latitude' in v) {
    if (v.latitude !== null && (typeof v.latitude !== 'number' || Math.abs(v.latitude) > 90)) throw invalid('Bad latitude')
    out.latitude = v.latitude ?? null
  }
  if ('longitude' in v) {
    if (v.longitude !== null && (typeof v.longitude !== 'number' || Math.abs(v.longitude) > 180)) throw invalid('Bad longitude')
    out.longitude = v.longitude ?? null
  }
  if ('laundry_weekdays' in v) out.laundry_weekdays = weekdays(v.laundry_weekdays ?? [], 'Laundry days')
  if ('drying_days' in v) out.drying_days = int(v.drying_days, 'Drying days', 0, 7) ?? 1
  if ('notification_prefs' in v) {
    const p = v.notification_prefs ?? {}
    out.notification_prefs = Object.fromEntries(
      Object.entries(p).filter(([k, val]) => ['laundry', 'ironing', 'plan', 'events', 'morning'].includes(k) && typeof val === 'boolean'),
    )
  }
  return out
}
