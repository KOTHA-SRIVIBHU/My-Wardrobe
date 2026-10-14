import { useCallback, useEffect, useState } from 'react'
import type { BasketStatus, GarmentState } from './types'

export const STATE_LABELS: Record<GarmentState, string> = {
  ready: 'Ready to Wear',
  worn_reusable: 'Worn — Reusable',
  needs_laundry: 'Needs Laundry',
  in_basket: 'In Laundry Basket',
  in_laundry: 'In Laundry',
  drying: 'Drying',
  needs_ironing: 'Needs Ironing',
  reserved: 'Reserved',
  unavailable: 'Unavailable',
}

export const STATE_COLORS: Record<GarmentState, string> = {
  ready: 'bg-emerald-100 text-emerald-800',
  worn_reusable: 'bg-teal-100 text-teal-800',
  needs_laundry: 'bg-amber-100 text-amber-800',
  in_basket: 'bg-sky-100 text-sky-800',
  in_laundry: 'bg-blue-100 text-blue-800',
  drying: 'bg-cyan-100 text-cyan-800',
  needs_ironing: 'bg-orange-100 text-orange-800',
  reserved: 'bg-violet-100 text-violet-800',
  unavailable: 'bg-slate-200 text-slate-700',
}

/** Compact labels for small cards. */
export const STATE_SHORT: Record<GarmentState, string> = {
  ready: 'Ready',
  worn_reusable: 'Worn',
  needs_laundry: 'Dirty',
  in_basket: 'In basket',
  in_laundry: 'Washing',
  drying: 'Drying',
  needs_ironing: 'To iron',
  reserved: 'Reserved',
  unavailable: 'Away',
}

export const STATE_DOT: Record<GarmentState, string> = {
  ready: 'bg-emerald-500',
  worn_reusable: 'bg-teal-500',
  needs_laundry: 'bg-amber-500',
  in_basket: 'bg-sky-500',
  in_laundry: 'bg-blue-600',
  drying: 'bg-cyan-500',
  needs_ironing: 'bg-orange-500',
  reserved: 'bg-violet-500',
  unavailable: 'bg-slate-400',
}

// Colour words people use that CSS doesn't know.
const EXTRA_COLORS: Record<string, string> = {
  denim: '#3b5b8c', charcoal: '#36454f', cream: '#f5f0dc', offwhite: '#f4f1ea', mustard: '#d9a514',
  burgundy: '#7a1f3d', wine: '#722f37', rust: '#b7410e', camel: '#c19a6b', stone: '#b9b2a5',
  mint: '#98d8c1', lilac: '#c8a2c8', rose: '#e8a0a8', emerald: '#2e8b57', taupe: '#8b7d6b',
  sand: '#d8c3a5', nude: '#e3bc9a', peach: '#f4b98f', mauve: '#b784a7', sage: '#9caf88',
}

/** Best-effort CSS colour for a free-text colour name ("Light Blue" -> "lightblue"). */
export function cssColor(name: string | null): string | null {
  if (!name) return null
  const key = name.toLowerCase().replace(/[^a-z]/g, '')
  if (EXTRA_COLORS[key]) return EXTRA_COLORS[key]
  if (typeof CSS !== 'undefined' && CSS.supports('color', key)) return key
  // "dark navy", "olive green": try the last word, then the first.
  const words = name.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  for (const w of [words[words.length - 1], words[0]]) {
    if (!w) continue
    if (EXTRA_COLORS[w]) return EXTRA_COLORS[w]
    if (typeof CSS !== 'undefined' && CSS.supports('color', w)) return w
  }
  return null
}

export const BASKET_LABELS: Record<BasketStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
}

export const BASKET_COLORS: Record<BasketStatus, string> = {
  pending: 'bg-sky-100 text-sky-800',
  in_progress: 'bg-blue-600 text-white',
  completed: 'bg-emerald-100 text-emerald-800',
}

/** The user's local calendar date as YYYY-MM-DD. */
export function localToday(): string {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Adds days to a YYYY-MM-DD date (calendar arithmetic, no time zones involved). */
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return dt.toISOString().slice(0, 10)
}

/** "Mon–Fri", "Every day", "Mon, Wed, Sat". Weekdays are 0 = Monday. */
export function weekdaysText(days: number[]): string {
  const s = [...days].sort()
  if (s.length === 7) return 'Every day'
  if (s.join() === '0,1,2,3,4') return 'Mon–Fri'
  if (s.join() === '5,6') return 'Weekends'
  return s.map((d) => WEEKDAY_SHORT[d]).join(', ') || 'No days'
}

/** Backend datetimes are naive UTC ("2026-10-13T08:00:00"); dates are plain YYYY-MM-DD. */
export function parseUtc(s: string): Date {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`)
}

export function fmtDate(s: string | null): string {
  if (!s) return '—'
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

export function fmtDateTime(s: string | null): string {
  if (!s) return '—'
  return parseUtc(s).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** UTC datetime string -> value for <input type="datetime-local">. */
export function toLocalInput(s: string | null): string {
  if (!s) return ''
  const d = parseUtc(s)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

export function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const UNCOUNTABLE = new Set([
  'trousers', 'jeans', 'shorts', 'socks', 'shoes', 'accessories', 'nightwear',
  'underwear', 'activewear', 'other',
])

/** Section heading for a category: "shirt" -> "Shirts", "jeans" -> "Jeans". */
export function categoryTitle(category: string): string {
  if (UNCOUNTABLE.has(category)) return capitalize(category)
  return capitalize(category) + (/(s|sh|ch|x)$/.test(category) ? 'es' : 's')
}

/** Groups items by category, in the app's category order, custom categories last (A–Z). */
export function groupByCategory<T extends { category: string }>(
  items: T[],
  order: string[],
): { category: string; items: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const list = groups.get(item.category)
    if (list) list.push(item)
    else groups.set(item.category, [item])
  }
  const rank = (c: string) => {
    const i = order.indexOf(c)
    return i === -1 ? order.length : i
  }
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, items]) => ({ category, items }))
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Minimal data loader: loading/error state plus a reload function. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fn, deps)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setData(await load())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [load])

  useEffect(() => {
    reload()
  }, [reload])

  return { data, setData, error, loading, reload }
}
