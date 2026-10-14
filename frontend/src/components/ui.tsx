import { useEffect, useState, type ReactNode } from 'react'
import { mediaUrl } from '../lib/api'
import { BASKET_COLORS, BASKET_LABELS, STATE_COLORS, STATE_DOT, STATE_LABELS, STATE_SHORT, WEEKDAY_SHORT, cssColor } from '../lib/format'
import type { BasketStatus, Garment, GarmentState } from '../lib/types'

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function StateBadge({ state }: { state: GarmentState }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STATE_COLORS[state]}`}>
      {STATE_LABELS[state]}
    </span>
  )
}

export function BasketBadge({ status }: { status: BasketStatus }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BASKET_COLORS[status]}`}>
      {BASKET_LABELS[status]}
    </span>
  )
}

const CATEGORY_ICONS: Record<string, string> = {
  shirt: '👔', 't-shirt': '👕', trousers: '👖', jeans: '👖', shorts: '🩳', skirt: '👗', dress: '👗',
  vest: '🎽', underwear: '🩲', socks: '🧦', nightwear: '🌙', sweater: '🧶', jacket: '🧥', suit: '🤵',
  activewear: '🏃', shoes: '👞', accessories: '👜',
}

export function GarmentThumb({
  garment,
  size = 'md',
}: {
  garment: Garment
  size?: 'sm' | 'md' | 'lg' | 'card'
}) {
  const cls = {
    sm: 'h-10 w-10 text-lg rounded-lg',
    md: 'h-16 w-16 text-2xl rounded-lg',
    lg: 'aspect-square w-full text-5xl rounded-lg',
    card: 'aspect-[4/5] w-full text-3xl',
  }[size]
  const url = mediaUrl(garment.image_url)
  if (url) return <img src={url} alt={garment.name} loading="lazy" className={`${cls} shrink-0 bg-slate-100 object-cover`} />
  // No photo: a soft tint of the garment's colour behind its category icon.
  const tint = cssColor(garment.color)
  return (
    <div
      className={`${cls} relative flex shrink-0 items-center justify-center overflow-hidden bg-slate-100`}
      aria-hidden
      style={tint ? { backgroundImage: `linear-gradient(135deg, color-mix(in srgb, ${tint} 35%, white), color-mix(in srgb, ${tint} 12%, #f1f5f9))` } : undefined}
    >
      <span className="drop-shadow-sm">{CATEGORY_ICONS[garment.category] ?? '🧺'}</span>
    </div>
  )
}

/** Compact state indicator: coloured dot + short label. */
export function StateDot({ state, className = '' }: { state: GarmentState; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 ${className}`} title={STATE_LABELS[state]}>
      <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[state]}`} />
      {STATE_SHORT[state]}
    </span>
  )
}

export function ColorSwatch({ color }: { color: string | null }) {
  const c = cssColor(color)
  if (!c) return null
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: c }} title={color ?? ''} />
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function ErrorBanner({ message, onDismiss }: { message: string | null; onDismiss?: () => void }) {
  if (!message) return null
  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <span>{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="text-red-500 hover:text-red-700" aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  )
}

export function Notice({ messages, onDismiss }: { messages: string[]; onDismiss: () => void }) {
  if (!messages.length) return null
  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <ul className="space-y-1">
        {messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      <button onClick={onDismiss} className="text-amber-600 hover:text-amber-800" aria-label="Dismiss">
        ✕
      </button>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center text-sm text-slate-500">{children}</div>
}

export function Spinner() {
  return <div className="py-10 text-center text-sm text-slate-500">Loading…</div>
}

export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
    >
      {children}
    </button>
  )
}

export function WeekdayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {WEEKDAY_SHORT.map((d, i) => (
        <Chip key={d} on={value.includes(i)} onClick={() => onChange(value.includes(i) ? value.filter((x) => x !== i) : [...value, i].sort())}>
          {d}
        </Chip>
      ))}
    </div>
  )
}

const ISSUE_STYLES = {
  error: 'border-red-200 bg-red-50 text-red-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  info: 'border-slate-200 bg-slate-50 text-slate-700',
}

export function IssueList({ issues }: { issues: { severity: 'error' | 'warning' | 'info'; message: string }[] }) {
  if (!issues.length) return null
  return (
    <ul className="space-y-1.5">
      {issues.map((i, n) => (
        <li key={n} className={`rounded-lg border px-3 py-2 text-sm ${ISSUE_STYLES[i.severity]}`}>
          {i.message}
        </li>
      ))}
    </ul>
  )
}

/** Free-text tags with suggestions; Enter or comma adds a tag. */
export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder,
}: {
  value: string[]
  onChange: (v: string[]) => void
  suggestions?: string[]
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')
  const has = (t: string) => value.some((v) => v.toLowerCase() === t.toLowerCase())
  const add = (t: string) => {
    const tag = t.trim()
    if (tag && !has(tag)) onChange([...value, tag])
    setDraft('')
  }
  const unused = suggestions.filter((s) => !has(s))
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-200">
        {value.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-800">
            {t}
            <button type="button" onClick={() => onChange(value.filter((v) => v !== t))} aria-label={`Remove ${t}`}>
              ✕
            </button>
          </span>
        ))}
        <input
          className="min-w-24 flex-1 py-0.5 text-sm outline-none"
          value={draft}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add(draft)
            } else if (e.key === 'Backspace' && !draft && value.length) {
              onChange(value.slice(0, -1))
            }
          }}
          onBlur={() => draft && add(draft)}
        />
      </div>
      {unused.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {unused.slice(0, 12).map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => add(s)}
              className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
