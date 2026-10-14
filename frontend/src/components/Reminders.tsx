import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { api } from '../lib/api'
import { localToday, useLoad } from '../lib/format'
import type { ReminderGroup } from '../lib/types'
import { Icon } from './Icon'

const GROUPS: { key: ReminderGroup; label: string; icon: string }[] = [
  { key: 'laundry', label: 'Laundry baskets', icon: '🧺' },
  { key: 'ironing', label: 'Ironing', icon: '♨️' },
  { key: 'plan', label: 'Plan problems', icon: '📋' },
  { key: 'events', label: 'Upcoming events', icon: '📅' },
]
const ICON = Object.fromEntries(GROUPS.map((g) => [g.key, g.icon]))

/** Header bell: in-app reminders, refreshed on every page change. */
export function Reminders() {
  const location = useLocation()
  const today = localToday()
  const items = useLoad(() => api.notifications(today), [today, location.pathname])
  const settings = useLoad(() => api.settings(), [])
  const [open, setOpen] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const prefs = { laundry: true, ironing: true, plan: true, events: true, ...(settings.data?.notification_prefs ?? {}) }
  const count = items.data?.length ?? 0

  async function toggle(key: ReminderGroup) {
    const next = { ...prefs, [key]: !prefs[key] }
    try {
      settings.setData(await api.updateSettings({ notification_prefs: next }))
      items.reload()
    } catch {
      /* keep the old preference; the bell still works */
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        className="relative rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        onClick={() => setOpen(!open)}
        aria-label={`Reminders${count ? ` (${count})` : ''}`}
        aria-expanded={open}
      >
        <Icon name="bell" />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] leading-4 font-semibold text-white">
            {count}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
            <span className="text-sm font-semibold">Reminders</span>
            <button className="text-xs text-indigo-700 hover:underline" onClick={() => setChoosing(!choosing)}>
              {choosing ? 'Done' : 'Choose'}
            </button>
          </div>
          {choosing ? (
            <ul className="space-y-2 px-4 py-3">
              {GROUPS.map((g) => (
                <li key={g.key}>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="accent-indigo-600" checked={prefs[g.key]} onChange={() => toggle(g.key)} />
                    {g.icon} {g.label}
                  </label>
                </li>
              ))}
            </ul>
          ) : count === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-500">You're all caught up.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {items.data?.map((r, i) => (
                <li key={i}>
                  <Link to={r.link} onClick={() => setOpen(false)} className="flex gap-2 px-4 py-2.5 text-sm hover:bg-slate-50">
                    <span aria-hidden>{ICON[r.group]}</span>
                    <span>{r.message}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
