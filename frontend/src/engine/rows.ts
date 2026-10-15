// Database row shapes (one per table in supabase/closetiq.sql). Dates are 'YYYY-MM-DD'
// strings, timestamps are ISO strings in UTC ('...Z').
import type { BasketKind, BasketStatus, GarmentState, IroningPolicy, Requirement } from '../lib/types'

export interface GarmentRow {
  id: string
  name: string
  category: string
  subcategory: string | null
  color: string | null
  pattern: string | null
  labels: string[]
  occasions: string[]
  formality: number | null
  seasons: string[]
  weather: string[]
  fabric: string | null
  comfort_notes: string | null
  max_wears_before_wash: number | null
  ironing_policy: IroningPolicy
  purchase_date: string | null
  purchase_price: number | null
  notes: string | null
  photo_id: string | null
  state: GarmentState
  iron_after_drying: boolean
  total_wears: number
  wears_since_wash: number
  last_worn_on: string | null
  last_washed_at: string | null
  archived: boolean
  archived_reason: string | null
  created_at: string
  updated_at: string
  rev: number
}

export interface PhotoRow {
  id: string
  garment_id: string
  mime: string
  data?: string // base64; loaded on demand, not kept in the store
  created_at: string
}

export interface PairRow {
  id: string
  name: string
  description: string | null
  labels: string[]
  occasion: string | null
  favorite: boolean
  notes: string | null
  created_at: string
  updated_at: string
  rev: number
}

export interface PairItemRow {
  id: string
  pair_id: string
  garment_id: string
  position: number
}

export interface BasketRow {
  id: string
  name: string
  kind: BasketKind
  description: string | null
  scheduled_for: string | null
  expected_completion_at: string | null
  status: BasketStatus
  notes: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  rev: number
}

export type ItemOutcome = 'washed' | 'not_processed' | 'removed' | 'ironed'

export interface BasketItemRow {
  id: string
  basket_id: string
  garment_id: string
  added_at: string
  previous_state: GarmentState
  active: boolean
  outcome: ItemOutcome | null
  resolved_at: string | null
}

export interface GarmentEventRow {
  id: string
  garment_id: string
  kind: string
  from_state: GarmentState | null
  to_state: GarmentState | null
  basket_id: string | null
  pair_id: string | null
  worn_on: string | null
  note: string | null
  at: string
}

export interface FeedbackRow {
  id: string
  garment_ids: string[]
  rating: number
  created_at: string
}

export interface RoutineRow {
  id: string
  name: string
  kind: 'day' | 'night'
  weekdays: number[]
  start_date: string | null
  end_date: string | null
  occasion: string | null
  formality: number | null
  requirements: Requirement[]
  mandatory: boolean
  active: boolean
  source_text: string | null
  notes: string | null
  created_at: string
  updated_at: string
  rev: number
}

export interface EventRow {
  id: string
  title: string
  kind: string
  date: string
  start_time: string | null
  end_time: string | null
  occasion: string | null
  formality: number | null
  labels: string[]
  notes: string | null
  skip_day_routines: boolean
  garment_ids: string[]
  created_at: string
  updated_at: string
  rev: number
}

export interface WeatherReportRow {
  id: string
  date: string
  tags: string[]
  created_at: string
}

export interface PlanEntryRow {
  id: string
  date: string
  slot_key: string
  title: string
  garment_ids: string[]
  locked: boolean
  status: 'planned' | 'worn' | 'skipped'
  created_at: string
  updated_at: string
  rev: number
}

export interface SettingsRow {
  id: 'me'
  location_name: string | null
  latitude: number | null
  longitude: number | null
  laundry_weekdays: number[]
  drying_days: number
  notification_prefs: Record<string, boolean>
  updated_at: string
  rev: number
}

export interface Tables {
  garments: GarmentRow
  photos: PhotoRow
  pairs: PairRow
  pair_items: PairItemRow
  laundry_baskets: BasketRow
  basket_items: BasketItemRow
  garment_events: GarmentEventRow
  outfit_feedback: FeedbackRow
  routines: RoutineRow
  events: EventRow
  weather_reports: WeatherReportRow
  plan_entries: PlanEntryRow
  settings: SettingsRow
}

export type TableName = keyof Tables

export const TABLES: TableName[] = [
  'garments', 'photos', 'pairs', 'pair_items', 'laundry_baskets', 'basket_items', 'garment_events',
  'outfit_feedback', 'routines', 'events', 'weather_reports', 'plan_entries', 'settings',
]

/** Tables with optimistic-concurrency revision numbers. */
export const VERSIONED = new Set<TableName>(['garments', 'pairs', 'laundry_baskets', 'routines', 'events', 'plan_entries', 'settings'])

/** Columns holding a timestamp (normalised to ISO 'Z' strings on load). */
export const TIMESTAMP_COLUMNS = new Set([
  'created_at', 'updated_at', 'last_washed_at', 'expected_completion_at', 'started_at', 'completed_at',
  'added_at', 'resolved_at', 'at',
])
