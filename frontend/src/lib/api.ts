import { getAccessToken, supabase } from './auth'
import type {
  AiStatus,
  Analytics,
  Brief,
  Coverage,
  PackingResult,
  PurchaseResult,
  Reminder,
  Basket,
  CalendarEvent,
  CalendarEventInput,
  Feasibility,
  Plan,
  Routine,
  RoutineDraft,
  RoutineInput,
  Settings,
  Simulation,
  WeatherDay,
  Classification,
  Explanation,
  Outfit,
  OutfitRequest,
  BasketMutation,
  Dashboard,
  Garment,
  GarmentEvent,
  GarmentFields,
  GarmentState,
  Meta,
  Pair,
  WashResult,
} from './types'

const BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  const token = await getAccessToken()
  if (token) headers.Authorization = `Bearer ${token}`
  let payload: BodyInit | undefined
  if (body instanceof FormData) {
    payload = body
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(BASE + path, { method, headers, body: payload })
  if (res.status === 401 && supabase) {
    // Session expired or revoked: back to the sign-in screen.
    await supabase.auth.signOut()
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = data?.detail
    const message =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map((d: { msg: string }) => d.msg).join('; ')
          : res.statusText || 'Request failed'
    throw new ApiError(res.status, message, data?.code)
  }
  return data as T
}

function qs(params: Record<string, string | boolean | undefined | null>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** Local-storage photo URLs come back relative to the API. */
export function mediaUrl(url: string | null): string | null {
  if (!url) return null
  return url.startsWith('/') ? BASE + url : url
}

export type GarmentInput = Partial<GarmentFields> & { name: string; category: string }

export interface GarmentFilters {
  state?: GarmentState | ''
  category?: string
  label?: string
  q?: string
  wearable?: boolean
  include_archived?: boolean
}

export const api = {
  meta: () => request<Meta>('GET', '/api/meta'),
  labels: () => request<string[]>('GET', '/api/labels'),
  dashboard: (today: string) => request<Dashboard>('GET', `/api/dashboard${qs({ today })}`),

  garments: (f: GarmentFilters = {}) => request<Garment[]>('GET', `/api/garments${qs({ ...f })}`),
  garment: (id: string) => request<Garment>('GET', `/api/garments/${id}`),
  createGarment: (body: GarmentInput) => request<Garment>('POST', '/api/garments', body),
  updateGarment: (id: string, body: Partial<GarmentFields>) => request<Garment>('PATCH', `/api/garments/${id}`, body),
  deleteGarment: (id: string) => request<void>('DELETE', `/api/garments/${id}`),
  uploadImage: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<Garment>('POST', `/api/garments/${id}/image`, form)
  },
  deleteImage: (id: string) => request<Garment>('DELETE', `/api/garments/${id}/image`),
  history: (id: string) => request<GarmentEvent[]>('GET', `/api/garments/${id}/history`),
  setState: (id: string, state: GarmentState, note?: string) =>
    request<Garment>('POST', `/api/garments/${id}/state`, { state, note }),
  archive: (id: string, reason: string) => request<Garment>('POST', `/api/garments/${id}/archive`, { reason }),
  unarchive: (id: string) => request<Garment>('POST', `/api/garments/${id}/unarchive`),

  wear: (garment_ids: string[], worn_on?: string) =>
    request<Garment[]>('POST', '/api/garments/actions/wear', { garment_ids, worn_on }),
  wash: (garment_ids: string[], dry: boolean, needs_ironing?: boolean) =>
    request<Garment[]>('POST', '/api/garments/actions/wash', { garment_ids, dry, needs_ironing }),
  dried: (garment_ids: string[]) => request<Garment[]>('POST', '/api/garments/actions/dried', { garment_ids }),
  needsIroning: (garment_ids: string[]) =>
    request<Garment[]>('POST', '/api/garments/actions/needs-ironing', { garment_ids }),
  ironed: (garment_ids: string[]) => request<Garment[]>('POST', '/api/garments/actions/ironed', { garment_ids }),

  pairs: () => request<Pair[]>('GET', '/api/pairs'),
  createPair: (body: Partial<Pair> & { name: string; garment_ids: string[] }) =>
    request<Pair>('POST', '/api/pairs', body),
  updatePair: (id: string, body: Partial<Pair> & { garment_ids?: string[] }) =>
    request<Pair>('PATCH', `/api/pairs/${id}`, body),
  deletePair: (id: string) => request<void>('DELETE', `/api/pairs/${id}`),
  duplicatePair: (id: string) => request<Pair>('POST', `/api/pairs/${id}/duplicate`),
  wearPair: (id: string, worn_on?: string) => request<Garment[]>('POST', `/api/pairs/${id}/wear`, { worn_on }),

  baskets: (status?: string, sort?: string) => request<Basket[]>('GET', `/api/baskets${qs({ status, sort })}`),
  basket: (id: string) => request<Basket>('GET', `/api/baskets/${id}`),
  createBasket: (body: Partial<Basket> & { name: string; garment_ids?: string[] }) =>
    request<BasketMutation>('POST', '/api/baskets', body),
  updateBasket: (id: string, body: Partial<Basket>) => request<Basket>('PATCH', `/api/baskets/${id}`, body),
  deleteBasket: (id: string) => request<void>('DELETE', `/api/baskets/${id}`),
  addToBasket: (id: string, garment_ids: string[]) =>
    request<BasketMutation>('POST', `/api/baskets/${id}/items`, { garment_ids }),
  removeFromBasket: (id: string, garmentId: string, confirm = false, restore_to?: GarmentState) =>
    request<Basket>('POST', `/api/baskets/${id}/items/${garmentId}/remove`, { confirm, restore_to }),
  startBasket: (id: string) => request<Basket>('POST', `/api/baskets/${id}/start`),
  completeBasket: (
    id: string,
    default_result: 'dry' | 'drying',
    outcomes: { garment_id: string; result: WashResult; needs_ironing?: boolean | null }[],
  ) => request<Basket>('POST', `/api/baskets/${id}/complete`, { default_result, outcomes }),

  aiStatus: () => request<AiStatus>('GET', '/api/ai/status'),
  classify: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<Classification>('POST', '/api/ai/classify', form)
  },
  generateOutfits: (body: OutfitRequest) =>
    request<{ outfits: Outfit[]; notes: string[] }>('POST', '/api/outfits/generate', body),
  outfitFeedback: (garment_ids: string[], rating: 1 | -1) =>
    request<void>('POST', '/api/outfits/feedback', { garment_ids, rating }),
  explainOutfit: (garment_ids: string[], occasion?: string | null, weather?: string[]) =>
    request<Explanation>('POST', '/api/outfits/explain', { garment_ids, occasion, weather }),

  routines: () => request<Routine[]>('GET', '/api/routines'),
  createRoutine: (body: RoutineInput) => request<Routine>('POST', '/api/routines', body),
  updateRoutine: (id: string, body: RoutineInput) => request<Routine>('PUT', `/api/routines/${id}`, body),
  deleteRoutine: (id: string) => request<void>('DELETE', `/api/routines/${id}`),
  interpretRoutines: (text: string) =>
    request<{ routines: RoutineDraft[]; questions: string[] }>('POST', '/api/routines/interpret', { text }),
  checkRoutines: (routine?: RoutineInput, routine_id?: string, days = 14) =>
    request<Feasibility>('POST', '/api/routines/check', { routine, routine_id, days }),

  events: (start?: string, end?: string) => request<CalendarEvent[]>('GET', `/api/events${qs({ start, end })}`),
  createEvent: (body: CalendarEventInput) => request<CalendarEvent>('POST', '/api/events', body),
  updateEvent: (id: string, body: CalendarEventInput) => request<CalendarEvent>('PUT', `/api/events/${id}`, body),
  deleteEvent: (id: string) => request<void>('DELETE', `/api/events/${id}`),

  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (body: Settings) => request<Settings>('PUT', '/api/settings', body),
  geocode: (q: string) =>
    request<{ name: string; latitude: number; longitude: number }[]>('GET', `/api/weather/geocode${qs({ q })}`),
  weather: (days: number, today: string) =>
    request<{ location: string | null; error: string | null; days: WeatherDay[] }>('GET', `/api/weather${qs({ days: String(days), today })}`),
  reportWeather: (date: string, tags: string[]) => request<void>('PUT', '/api/weather/reports', { date, tags }),

  plan: (start: string, days: number, today: string) =>
    request<Plan>('GET', `/api/plan${qs({ start, days: String(days), today })}`),
  generatePlan: (start: string, days: number, today: string, dates?: string[]) =>
    request<Plan>('POST', `/api/plan/generate${qs({ today })}`, { start, days, dates }),
  saveEntry: (body: { date: string; slot_key: string; title: string; garment_ids: string[]; locked?: boolean }) =>
    request<{ id: string }>('POST', '/api/plan/entries', body),
  updateEntry: (id: string, body: { locked?: boolean; garment_ids?: string[]; status?: string }) =>
    request<void>('PATCH', `/api/plan/entries/${id}`, body),
  wearEntry: (id: string, today: string) => request<Garment[]>('POST', `/api/plan/entries/${id}/wear${qs({ today })}`),
  simulate: (body: { basket_id?: string; garment_ids?: string[]; wash_on?: string; days?: number }, today: string) =>
    request<Simulation>('POST', `/api/plan/simulate${qs({ today })}`, body),

  coverage: (today: string) => request<Coverage>('GET', `/api/plan/coverage${qs({ today })}`),
  brief: (today: string) => request<Brief>('POST', `/api/plan/brief${qs({ today })}`),
  analytics: (days: number, today: string) => request<Analytics>('GET', `/api/analytics${qs({ days: String(days), today })}`),
  packing: (
    body: { start: string; nights: number; activities: string[]; laundry_available: boolean },
    today: string,
  ) => request<PackingResult>('POST', `/api/packing${qs({ today })}`, body),
  purchase: (
    body: { category: string; color?: string | null; pattern?: string | null; formality?: number | null; weather?: string[]; occasions?: string[] },
    today: string,
  ) => request<PurchaseResult>('POST', `/api/analysis/purchase${qs({ today })}`, body),
  notifications: (today: string) => request<Reminder[]>('GET', `/api/notifications${qs({ today })}`),
  updateSettings: (body: Partial<Settings>) => request<Settings>('PUT', '/api/settings', body),
  deleteAccount: () => request<{ deleted: boolean; login_removed: boolean }>('DELETE', '/api/account?confirm=true'),
  importBackup: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ restored: Record<string, number> }>('POST', '/api/import?confirm=true', form)
  },
}

/** Downloads the full backup as a JSON file (photos included). */
export async function downloadBackup(): Promise<void> {
  const headers: Record<string, string> = {}
  const token = await getAccessToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}/api/export?photos=true`, { headers })
  if (!res.ok) throw new ApiError(res.status, 'Export failed')
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = `closetiq-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** Shrinks a photo to fit within maxSide px as JPEG, to save upload time and AI tokens. */
export async function downscaleImage(file: File, maxSide = 1024): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file
  } catch {
    return file // unsupported format in this browser: send as-is and let the server validate
  }
}
