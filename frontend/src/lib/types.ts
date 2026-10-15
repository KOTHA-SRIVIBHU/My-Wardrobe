// Mirrors backend/app/schemas.py.

export type GarmentState =
  | 'ready'
  | 'worn_reusable'
  | 'needs_laundry'
  | 'in_basket'
  | 'in_laundry'
  | 'drying'
  | 'needs_ironing'
  | 'reserved'
  | 'unavailable'

export type IroningPolicy = 'not_required' | 'required' | 'optional' | 'user_decides'
export type BasketStatus = 'pending' | 'in_progress' | 'completed'
export type BasketKind = 'laundry' | 'ironing'
export type WashResult = 'dry' | 'drying' | 'unavailable' | 'not_processed'

export interface BasketRef {
  id: string
  name: string
  status: BasketStatus
  kind: BasketKind
}

export interface GarmentFields {
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
  purchase_price: string | null
  notes: string | null
}

export interface Garment extends GarmentFields {
  id: string
  image_url: string | null
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
  wearable: boolean
  active_basket: BasketRef | null
}

export interface GarmentEvent {
  id: string
  kind: string
  from_state: GarmentState | null
  to_state: GarmentState | null
  basket_id: string | null
  pair_id: string | null
  worn_on: string | null
  note: string | null
  at: string
}

export interface Blocker {
  garment_id: string
  garment_name: string
  reason: string
}

export interface Pair {
  id: string
  name: string
  description: string | null
  labels: string[]
  occasion: string | null
  favorite: boolean
  notes: string | null
  created_at: string
  updated_at: string
  garments: Garment[]
  wearable: boolean
  blockers: Blocker[]
}

export interface BasketItem {
  id: string
  garment: Garment
  added_at: string
  previous_state: GarmentState
  active: boolean
  outcome: 'washed' | 'not_processed' | 'removed' | 'ironed' | null
  resolved_at: string | null
}

export interface Basket {
  id: string
  kind: BasketKind
  name: string
  description: string | null
  scheduled_for: string | null
  expected_completion_at: string | null
  notes: string | null
  status: BasketStatus
  created_at: string
  started_at: string | null
  completed_at: string | null
  garment_count: number
  items: BasketItem[]
}

export interface BasketMutation {
  basket: Basket
  warnings: string[]
}

export interface DashboardWarning {
  kind: string
  message: string
  basket_id: string | null
  garment_id: string | null
}

export interface Dashboard {
  today: string
  garments_total: number
  garments_wearable: number
  state_counts: Record<GarmentState, number>
  category_counts: Record<string, { total: number; wearable: number }>
  baskets_pending: Basket[]
  baskets_due_today: Basket[]
  baskets_in_progress: Basket[]
  baskets_recently_completed: Basket[]
  ironing_basket: Basket | null
  drying: Garment[]
  needs_ironing: Garment[]
  needs_laundry: Garment[]
  warnings: DashboardWarning[]
}

export interface Meta {
  states: { value: GarmentState; label: string }[]
  wearable_states: GarmentState[]
  ironing_policies: IroningPolicy[]
  categories: { value: string; max_wears_before_wash: number | null; ironing_policy: IroningPolicy }[]
  suggested_labels: string[]
  occasions: string[]
  seasons: string[]
  weather: string[]
  patterns: string[]
}

export interface AiStatus {
  enabled: boolean
  provider: string
  vision_model: string
  text_model: string
  daily_limit: number
  used_today: number
}

export interface Classification {
  name: string | null
  category: string
  subcategory: string | null
  color: string | null
  pattern: string | null
  fabric: string | null
  formality: number | null
  occasions: string[]
  labels: string[]
  seasons: string[]
  weather: string[]
}

export interface Outfit {
  garments: Garment[]
  score: number
  breakdown: Record<string, number>
  reasons: string[]
  cautions: string[]
}

export interface OutfitRequest {
  occasion?: string | null
  formality?: number | null
  weather?: string[]
  count?: number
  today?: string
}

export interface Explanation {
  summary: string
  tips: string[]
}

// --- Planning ------------------------------------------------------------------

export interface Requirement {
  category: string
  quantity: number
  labels: string[]
  min_formality: number | null
  reuse: 'rotate' | 'fixed'
  no_consecutive: boolean
}

export interface RoutineInput {
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
  notes: string | null
  source_text: string | null
}

export interface Routine extends RoutineInput {
  id: string
  created_at: string
  updated_at: string
}

export interface RoutineDraft {
  name: string
  kind: 'day' | 'night'
  weekdays: number[]
  occasion: string | null
  formality: number | null
  mandatory: boolean
  requirements: Requirement[]
}

export interface PlanIssue {
  kind: string
  severity: 'error' | 'warning' | 'info'
  message: string
  date: string | null
  slot_key: string | null
}

export interface Feasibility {
  ok: boolean
  days: number
  issues: PlanIssue[]
}

export type EventKind = 'office' | 'college' | 'holiday' | 'party' | 'interview' | 'wedding' | 'travel' | 'gym' | 'custom'

export interface CalendarEventInput {
  title: string
  kind: EventKind
  date: string
  start_time: string | null
  end_time: string | null
  occasion: string | null
  formality: number | null
  labels: string[]
  notes: string | null
  skip_day_routines: boolean | null
  garment_ids: string[]
}

export interface CalendarEvent extends CalendarEventInput {
  id: string
  skip_day_routines: boolean
}

export interface Settings {
  location_name: string | null
  latitude: number | null
  longitude: number | null
  laundry_weekdays: number[]
  drying_days: number
  notification_prefs?: Partial<Record<'laundry' | 'ironing' | 'plan' | 'events', boolean>>
}

export interface DayWeather {
  temp_max: number | null
  temp_min: number | null
  feels_max: number | null
  precip_probability: number | null
  wind_max: number | null
  humidity: number | null
  tags: string[]
}

export interface WeatherDay {
  date: string
  forecast: DayWeather | null
  reported: string[]
  weather: string[]
}

export interface PlanSlot {
  key: string
  title: string
  source: 'routine' | 'event'
  routine_id: string | null
  event_id: string | null
  entry_id: string | null
  saved: boolean
  locked: boolean
  status: 'planned' | 'worn' | 'skipped'
  garments: Garment[]
  problems: string[]
  prep: string[]
}

export interface PlanDay {
  date: string
  forecast: DayWeather | null
  reported: string[]
  weather: string[]
  events: CalendarEvent[]
  slots: PlanSlot[]
  issues: PlanIssue[]
}

export interface Plan {
  start: string
  days: PlanDay[]
  issues: PlanIssue[]
  affected_dates: string[]
  has_plan: boolean
  location: string | null
  weather_error: string | null
}

export interface Simulation {
  wash_on: string
  returns_on: string
  unavailable: Garment[]
  pairs_possible: { id: string; name: string }[]
  pairs_blocked: { id: string; name: string }[]
  scarce: string[]
  new_issues: PlanIssue[]
  resolved_issues: PlanIssue[]
  affected_events: string[]
  preparation: string[]
  covered: boolean
}

// --- Insights & backup --------------------------------------------------------------

export interface GarmentStat {
  id: string
  name: string
  category: string
  value: number
}

export interface Analytics {
  declutter: DeclutterItem[]
  period_days: number
  garments_total: number
  garments_ready: number
  wears_in_period: number
  never_worn: number
  most_worn: GarmentStat[]
  least_worn: GarmentStat[]
  weekly_wears: { week: string; wears: number }[]
  repeated_outfits: { garments: string[]; times: number }[]
  laundry_runs: number
  garments_washed: number
  last_laundry: string | null
  awaiting_ironing: number
  cost_per_wear: GarmentStat[]
  average_cost_per_wear: number | null
  categories: Record<string, { total: number; ready: number; wears: number }>
  shortages: string[]
}

export interface PackingResult {
  days: number
  weather: string[]
  sections: { title: string; needed: number; garments: Garment[]; shortfall: string | null }[]
  notes: string[]
}

export interface PurchaseResult {
  new_outfits: number
  strong_outfits: number
  examples: { garments: string[]; score: number }[]
  similar_owned: string[]
  category_owned: number
  verdict: string
}

export type ReminderGroup = 'laundry' | 'ironing' | 'plan' | 'events'

export interface Reminder {
  group: ReminderGroup
  message: string
  link: string
}

// --- Coverage ---------------------------------------------------------------------

export interface CoverageShortage {
  routine: string
  category: string
  required: number
  available: number
  missing: number
  first_short: string | null
  mandatory: boolean
}

export interface CoverageSuggestion {
  kind: 'schedule' | 'wash' | 'stock'
  title: string
  detail: string
  basket_id: string | null
  wash_on: string | null
  garment_ids: string[]
}

export interface StockLine {
  routine: string
  category: string
  needed: number
  owned: number
  ok: boolean
  cycle_days: number
}

export interface Coverage {
  today: string
  until: string
  days: number
  horizon: string
  next_laundry: string | null
  next_laundry_reason: string | null
  status: 'ok' | 'warning' | 'alert' | 'none'
  headline: string
  shortages: CoverageShortage[]
  suggestions: CoverageSuggestion[]
  stock: StockLine[]
}

export interface Brief {
  summary: string
  bullets: string[]
  tips: string[]
  status: Coverage['status']
}

export interface DeclutterItem {
  id: string
  name: string
  category: string
  last_worn_on: string | null
  idle_days: number
  never_worn: boolean
}
