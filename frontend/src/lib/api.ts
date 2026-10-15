// The app's data API. Same calls the pages always used, now answered on the device by
// the wardrobe service (talking to the user's own Supabase vault).
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { useEffect, useState } from 'react'
import { ApiError } from '../engine/errors'
import type { GarmentFilters, GarmentInput } from '../engine/service'
import { getService, isNative } from './connection'
import type {
  Basket, BasketStatus, CalendarEventInput, GarmentFields, GarmentState, OutfitRequest, Pair, RoutineInput,
  Settings, WashResult,
} from './types'

export { ApiError }
export type { GarmentFilters, GarmentInput }

const svc = () => getService()

/** Kept for older call sites: photo URLs are already displayable. */
export function mediaUrl(url: string | null): string | null {
  return url
}

export const api = {
  meta: () => svc().meta(),
  labels: () => svc().labels(),
  dashboard: (today: string) => svc().dashboard(today),

  garments: (f: GarmentFilters = {}) => svc().garments(f),
  garment: (id: string) => svc().garment(id),
  createGarment: (body: GarmentInput) => svc().createGarment(body),
  updateGarment: (id: string, body: Partial<GarmentFields>) => svc().updateGarment(id, body),
  deleteGarment: (id: string) => svc().deleteGarment(id),
  uploadImage: async (id: string, file: File) => {
    const small = await downscaleImage(file, 900, 0.8)
    const { mime, base64 } = await fileToBase64(small)
    return svc().savePhoto(id, mime, base64)
  },
  deleteImage: (id: string) => svc().deleteImage(id),
  history: (id: string) => svc().history(id),
  setState: (id: string, state: GarmentState, note?: string) => svc().setState(id, state, note),
  archive: (id: string, reason: string) => svc().archive(id, reason),
  unarchive: (id: string) => svc().unarchive(id),

  wear: (garmentIds: string[], wornOn?: string) => svc().wear(garmentIds, wornOn),
  wash: (garmentIds: string[], dry: boolean, needsIroning?: boolean) => svc().wash(garmentIds, dry, needsIroning),
  dried: (garmentIds: string[]) => svc().dried(garmentIds),
  needsIroning: (garmentIds: string[]) => svc().needsIroning(garmentIds),
  ironed: (garmentIds: string[]) => svc().ironed(garmentIds),

  pairs: () => svc().pairs(),
  createPair: (body: Partial<Pair> & { name: string; garment_ids: string[] }) => svc().createPair(body),
  updatePair: (id: string, body: Partial<Pair> & { garment_ids?: string[] }) => svc().updatePair(id, body),
  deletePair: (id: string) => svc().deletePair(id),
  duplicatePair: (id: string) => svc().duplicatePair(id),
  wearPair: (id: string, wornOn?: string) => svc().wearPair(id, wornOn),

  baskets: (status?: BasketStatus | string, sort?: string) => svc().baskets(status, sort),
  basket: (id: string) => svc().basket(id),
  createBasket: (body: Partial<Basket> & { name: string; garment_ids?: string[] }) => svc().createBasket(body),
  updateBasket: (id: string, body: Partial<Basket>) => svc().updateBasket(id, body),
  deleteBasket: (id: string) => svc().deleteBasket(id),
  addToBasket: (id: string, garmentIds: string[]) => svc().addToBasket(id, garmentIds),
  removeFromBasket: (id: string, garmentId: string, confirm = false, restoreTo?: GarmentState) =>
    svc().removeFromBasket(id, garmentId, confirm, restoreTo),
  startBasket: (id: string) => svc().startBasket(id),
  completeBasket: (
    id: string,
    defaultResult: 'dry' | 'drying',
    outcomes: { garment_id: string; result: WashResult; needs_ironing?: boolean | null }[],
  ) => svc().completeBasket(id, defaultResult, outcomes),

  aiStatus: () => svc().aiStatus(),
  classify: async (file: File) => svc().classify(await fileToDataUrl(await downscaleImage(file, 1024, 0.85))),
  generateOutfits: (body: OutfitRequest) => svc().generateOutfits(body),
  outfitFeedback: (garmentIds: string[], rating: 1 | -1) => svc().outfitFeedback(garmentIds, rating),
  explainOutfit: (garmentIds: string[], occasion?: string | null, weather?: string[]) => svc().explainOutfit(garmentIds, occasion, weather),

  routines: () => svc().routines(),
  createRoutine: (body: RoutineInput) => svc().createRoutine(body),
  updateRoutine: (id: string, body: RoutineInput) => svc().updateRoutine(id, body),
  deleteRoutine: (id: string) => svc().deleteRoutine(id),
  interpretRoutines: (text: string) => svc().interpretRoutines(text),
  checkRoutines: (routine?: RoutineInput, routineId?: string, days = 14) => svc().checkRoutines(routine, routineId, days),

  events: (start?: string, end?: string) => svc().events(start, end),
  createEvent: (body: CalendarEventInput) => svc().createEvent(body),
  updateEvent: (id: string, body: CalendarEventInput) => svc().updateEvent(id, body),
  deleteEvent: (id: string) => svc().deleteEvent(id),

  settings: () => svc().settings(),
  saveSettings: (body: Settings) => svc().saveSettings(body),
  updateSettings: (body: Partial<Settings>) => svc().updateSettings(body),
  geocode: (q: string) => svc().geocode(q),
  weather: (days: number, today: string) => svc().weather(days, today),
  reportWeather: (date: string, tags: string[]) => svc().reportWeather(date, tags),

  plan: (start: string, days: number, today: string) => svc().plan(start, days, today),
  generatePlan: (start: string, days: number, today: string, dates?: string[]) => svc().generatePlan(start, days, today, dates),
  saveEntry: (body: { date: string; slot_key: string; title: string; garment_ids: string[]; locked?: boolean }) => svc().saveEntry(body),
  updateEntry: (id: string, body: { locked?: boolean; garment_ids?: string[]; status?: string }) => svc().updateEntry(id, body),
  wearEntry: (id: string, today: string) => svc().wearEntry(id, today),
  simulate: (body: { basket_id?: string; garment_ids?: string[]; wash_on?: string; days?: number }, today: string) => svc().simulate(body, today),

  coverage: (today: string) => svc().coverage(today),
  brief: (today: string) => svc().brief(today),
  analytics: (days: number, today: string) => svc().analytics(days, today),
  packing: (body: { start: string; nights: number; activities: string[]; laundry_available: boolean }, today: string) => svc().packing(body, today),
  purchase: (body: { category: string; color?: string | null; pattern?: string | null; formality?: number | null; weather?: string[]; occasions?: string[] }, today: string) =>
    svc().purchase(body, today),
  notifications: (today: string) => svc().notifications(today),
  deleteAccount: () => svc().deleteAllData(),
  importBackup: async (file: File) => {
    let data: unknown
    try {
      data = JSON.parse(await file.text())
    } catch {
      throw new ApiError(422, "That file isn't valid JSON.", 'invalid')
    }
    if (!data || typeof data !== 'object') throw new ApiError(422, "That file isn't a ClosetIQ backup.", 'invalid')
    return { restored: await svc().importData(data as Record<string, unknown>) }
  },
}

/** Save the full backup: share sheet on the phone, a download on the web. */
export async function downloadBackup(): Promise<void> {
  const data = JSON.stringify(await svc().exportData(true))
  const name = `closetiq-backup-${new Date().toISOString().slice(0, 10)}.json`
  if (isNative) {
    const written = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache, encoding: Encoding.UTF8 })
    await Share.share({ title: 'ClosetIQ backup', url: written.uri, dialogTitle: 'Save your ClosetIQ backup' })
    return
  }
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** A garment photo as a displayable URL (fetched once, then cached). */
export function usePhoto(photoId: string | null): string | null {
  const s = (() => {
    try {
      return getService()
    } catch {
      return null
    }
  })()
  const [url, setUrl] = useState<string | null>(() => (photoId && s ? s.cachedPhoto(photoId) : null))
  useEffect(() => {
    let alive = true
    if (!photoId || !s) {
      setUrl(null)
      return
    }
    const hit = s.cachedPhoto(photoId)
    if (hit) {
      setUrl(hit)
      return
    }
    void s.photoUrl(photoId).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [photoId, s])
  return url
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new ApiError(422, "Couldn't read that photo.", 'invalid'))
    r.readAsDataURL(file)
  })
}

async function fileToBase64(file: Blob): Promise<{ mime: string; base64: string }> {
  const url = await fileToDataUrl(file)
  const m = url.match(/^data:([^;]+);base64,(.*)$/)
  if (!m) throw new ApiError(422, "Couldn't read that photo.", 'invalid')
  return { mime: m[1], base64: m[2] }
}

/** Shrinks a photo to fit within maxSide px as JPEG, to save space and AI tokens. */
export async function downscaleImage(file: File, maxSide = 1024, quality = 0.85): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file
  } catch {
    return file // unsupported format here: send as-is and let validation decide
  }
}
