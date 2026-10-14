import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMeta } from '../App'
import { GarmentPicker } from '../components/GarmentPicker'
import { Icon } from '../components/Icon'
import { ErrorBanner, GarmentThumb, Modal, PageHeader, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { WEEKDAY_SHORT, addDays, capitalize, fmtDate, localToday, useLoad, weekdaysText } from '../lib/format'
import type { CalendarEvent, CalendarEventInput, EventKind, WeatherDay } from '../lib/types'

const KINDS: { value: EventKind; label: string; icon: string }[] = [
  { value: 'office', label: 'Office', icon: '💼' },
  { value: 'college', label: 'College', icon: '🎓' },
  { value: 'holiday', label: 'Holiday', icon: '🏖️' },
  { value: 'party', label: 'Party', icon: '🎉' },
  { value: 'interview', label: 'Interview', icon: '🤝' },
  { value: 'wedding', label: 'Wedding', icon: '💍' },
  { value: 'travel', label: 'Travel', icon: '✈️' },
  { value: 'gym', label: 'Gym', icon: '🏋️' },
  { value: 'custom', label: 'Other', icon: '📌' },
]
const ICON = Object.fromEntries(KINDS.map((k) => [k.value, k.icon]))
const KIND_STYLE: Record<EventKind, string> = {
  office: 'bg-blue-100 text-blue-800',
  college: 'bg-sky-100 text-sky-800',
  holiday: 'bg-emerald-100 text-emerald-800',
  party: 'bg-pink-100 text-pink-800',
  interview: 'bg-violet-100 text-violet-800',
  wedding: 'bg-rose-100 text-rose-800',
  travel: 'bg-amber-100 text-amber-800',
  gym: 'bg-lime-100 text-lime-800',
  custom: 'bg-slate-100 text-slate-700',
}
const KIND_DOT: Record<EventKind, string> = {
  office: 'bg-blue-500', college: 'bg-sky-500', holiday: 'bg-emerald-500', party: 'bg-pink-500',
  interview: 'bg-violet-500', wedding: 'bg-rose-500', travel: 'bg-amber-500', gym: 'bg-lime-500', custom: 'bg-slate-400',
}
// Sensible dress-code defaults when picking a kind; the user can change them.
const KIND_DEFAULTS: Partial<Record<EventKind, { occasion: string; formality: number }>> = {
  office: { occasion: 'Office', formality: 4 },
  college: { occasion: 'College', formality: 2 },
  party: { occasion: 'Party', formality: 3 },
  interview: { occasion: 'Interview', formality: 5 },
  wedding: { occasion: 'Wedding', formality: 5 },
  gym: { occasion: 'Gym', formality: 1 },
}

function weatherIcon(tags: string[]): string | null {
  if (tags.includes('Rainy')) return '🌧️'
  if (tags.includes('Cold')) return '❄️'
  if (tags.includes('Hot')) return '☀️'
  if (tags.includes('Windy')) return '💨'
  if (tags.includes('Warm')) return '🌤️'
  if (tags.includes('Mild')) return '⛅'
  return null
}

/** Monday-first weeks covering the month that starts on `month` (YYYY-MM-01). */
function monthCells(month: string): string[] {
  const [y, m] = month.split('-').map(Number)
  const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const start = addDays(month, -offset)
  return Array.from({ length: Math.ceil((offset + daysInMonth) / 7) * 7 }, (_, i) => addDays(start, i))
}

function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return d.toISOString().slice(0, 10)
}

function weekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

export default function Calendar() {
  const today = localToday()
  const [month, setMonth] = useState(today.slice(0, 8) + '01')
  const [selected, setSelected] = useState(today)
  const [editing, setEditing] = useState<CalendarEvent | { date: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const cells = monthCells(month)
  const first = cells[0]
  const last = cells[cells.length - 1]
  const events = useLoad(() => api.events(first, last), [first, last])
  const baskets = useLoad(() => api.baskets(), [])
  const routines = useLoad(() => api.routines(), [])
  const garments = useLoad(() => api.garments(), [])
  const weather = useLoad(() => api.weather(16, today).catch(() => null), [today])

  const eventsOn = (d: string) => (events.data ?? []).filter((e) => e.date === d)
  const laundryOn = (d: string) =>
    (baskets.data ?? []).filter((b) => b.kind !== 'ironing' && b.status !== 'completed' && b.scheduled_for === d)
  const weatherOn = (d: string): WeatherDay | undefined => weather.data?.days.find((w) => w.date === d)
  const byId = new Map((garments.data ?? []).map((g) => [g.id, g]))
  const upcoming = (events.data ?? []).filter((e) => e.date >= today).slice(0, 5)

  const monthTitle = new Date(`${month}T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const dayEvents = eventsOn(selected)
  const skipsRoutines = dayEvents.some((e) => e.skip_day_routines)
  const dayRoutines = (routines.data ?? []).filter(
    (r) => r.active && r.weekdays.includes(weekday(selected)) && !(skipsRoutines && r.kind === 'day'),
  )
  const w = weatherOn(selected)

  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle="Holidays, parties and special days. Your plan adapts to them."
        actions={
          <button className="btn btn-primary" onClick={() => setEditing({ date: selected })}>
            <Icon name="plus" className="h-4 w-4" /> Add event
          </button>
        }
      />
      <ErrorBanner message={error ?? events.error} onDismiss={() => setError(null)} />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-lg font-semibold">{monthTitle}</h2>
            <div className="flex items-center gap-1">
              <button className="rounded-lg p-1.5 hover:bg-slate-100" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
                <Icon name="left" className="h-4 w-4" />
              </button>
              <button
                className="rounded-lg px-2.5 py-1 text-sm font-medium hover:bg-slate-100"
                onClick={() => {
                  setMonth(today.slice(0, 8) + '01')
                  setSelected(today)
                }}
              >
                Today
              </button>
              <button className="rounded-lg p-1.5 hover:bg-slate-100" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
                <Icon name="right" className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50 text-center text-xs font-medium text-slate-500">
            {WEEKDAY_SHORT.map((d) => (
              <div key={d} className="py-2">{d}</div>
            ))}
          </div>
          {events.loading && !events.data ? (
            <Spinner />
          ) : (
            <div className="grid grid-cols-7">
              {cells.map((d) => {
                const inMonth = d.slice(0, 7) === month.slice(0, 7)
                const evs = eventsOn(d)
                const loads = laundryOn(d)
                const wi = weatherIcon(weatherOn(d)?.weather ?? [])
                const isToday = d === today
                const isSelected = d === selected
                return (
                  <button
                    key={d}
                    onClick={() => setSelected(d)}
                    onDoubleClick={() => setEditing({ date: d })}
                    className={`relative flex h-16 flex-col border-r border-b border-slate-100 p-1 text-left align-top transition sm:h-24 lg:h-28 sm:p-1.5 ${inMonth ? 'bg-white' : 'bg-slate-50/70 text-slate-400'} ${isSelected ? 'z-10 ring-2 ring-indigo-500 ring-inset' : 'hover:bg-indigo-50/40'}`}
                    aria-label={`${fmtDate(d)}${evs.length ? `, ${evs.length} event(s)` : ''}`}
                    aria-pressed={isSelected}
                  >
                    <span className="flex items-center justify-between">
                      <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${isToday ? 'bg-indigo-600 text-white' : ''}`}>
                        {Number(d.slice(8))}
                      </span>
                      {wi && <span className="text-xs" title={weatherOn(d)?.weather.join(', ')}>{wi}</span>}
                    </span>
                    {/* Larger screens: chips. Phones: dots. */}
                    <span className="mt-0.5 hidden min-w-0 flex-1 flex-col gap-0.5 overflow-hidden sm:flex">
                      {evs.slice(0, 2).map((e) => (
                        <span key={e.id} className={`truncate rounded px-1 py-0.5 text-[11px] leading-tight font-medium ${KIND_STYLE[e.kind as EventKind] ?? KIND_STYLE.custom}`}>
                          {ICON[e.kind]} {e.title}
                        </span>
                      ))}
                      {loads.slice(0, 1).map((b) => (
                        <span key={b.id} className="truncate rounded bg-cyan-50 px-1 py-0.5 text-[11px] leading-tight text-cyan-800">🧺 {b.name}</span>
                      ))}
                      {evs.length + loads.length > 3 && <span className="text-[10px] text-slate-500">+{evs.length + loads.length - 3} more</span>}
                    </span>
                    <span className="mt-auto flex gap-0.5 sm:hidden">
                      {evs.slice(0, 3).map((e) => (
                        <span key={e.id} className={`h-1.5 w-1.5 rounded-full ${KIND_DOT[e.kind as EventKind] ?? KIND_DOT.custom}`} />
                      ))}
                      {loads.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-cyan-500" />}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <section className="card p-4">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold">{selected === today ? 'Today' : fmtDate(selected)}</h2>
                {w?.forecast && (
                  <p className="text-sm text-slate-500">
                    {weatherIcon(w.weather)} {Math.round(w.forecast.temp_max ?? 0)}° / {Math.round(w.forecast.temp_min ?? 0)}°
                    {w.weather.length ? ` · ${w.weather.join(', ')}` : ''}
                  </p>
                )}
              </div>
              <button className="btn btn-secondary px-2 py-1 text-xs" onClick={() => setEditing({ date: selected })}>
                <Icon name="plus" className="h-3.5 w-3.5" /> Event
              </button>
            </div>
            {dayEvents.length === 0 && laundryOn(selected).length === 0 && <p className="mb-3 text-sm text-slate-500">No events.</p>}
            <ul className="space-y-2">
              {dayEvents.map((e) => (
                <li key={e.id}>
                  <button className="w-full rounded-lg border border-slate-200 p-2.5 text-left hover:border-indigo-300" onClick={() => setEditing(e)}>
                    <span className="flex items-center gap-2 font-medium">
                      <span className={`h-2 w-2 rounded-full ${KIND_DOT[e.kind as EventKind] ?? KIND_DOT.custom}`} />
                      {e.title}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {[
                        e.start_time && `${e.start_time}${e.end_time ? `–${e.end_time}` : ''}`,
                        e.occasion,
                        e.formality && `formality ${e.formality}`,
                        e.skip_day_routines && 'replaces usual routines',
                      ].filter(Boolean).join(' · ') || capitalize(e.kind)}
                    </span>
                    {e.garment_ids.length > 0 && (
                      <span className="mt-2 flex gap-1.5">
                        {e.garment_ids.map((id) => byId.get(id)).filter(Boolean).map((g) => (
                          <GarmentThumb key={g!.id} garment={g!} size="sm" />
                        ))}
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {laundryOn(selected).map((b) => (
                <li key={b.id}>
                  <Link to={`/laundry/${b.id}`} className="flex items-center gap-2 rounded-lg border border-cyan-200 bg-cyan-50 p-2.5 text-sm text-cyan-900">
                    <Icon name="washer" className="h-4 w-4" /> Laundry: {b.name} ({b.garment_count})
                  </Link>
                </li>
              ))}
            </ul>
            {dayRoutines.length > 0 && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <p className="mb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">Routines that day</p>
                <ul className="text-sm text-slate-700">
                  {dayRoutines.map((r) => (
                    <li key={r.id}>
                      {r.kind === 'night' ? '🌙' : '☀️'} {r.name} <span className="text-xs text-slate-400">({weekdaysText(r.weekdays)})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {skipsRoutines && <p className="mt-2 text-xs text-emerald-700">Daytime routines are off this day.</p>}
            <Link to="/plan" className="mt-3 inline-block text-sm text-indigo-700 hover:underline">See the outfit plan →</Link>
          </section>

          <section className="card p-4">
            <h2 className="mb-2 text-sm font-semibold">Coming up</h2>
            {upcoming.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing scheduled this month.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {upcoming.map((e) => (
                  <li key={e.id}>
                    <button className="flex w-full items-center gap-2 text-left hover:text-indigo-700" onClick={() => setSelected(e.date)}>
                      <span className="w-20 shrink-0 text-xs text-slate-500">{e.date === today ? 'Today' : fmtDate(e.date)}</span>
                      <span className="truncate">{ICON[e.kind]} {e.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      {editing && (
        <EventForm
          event={'id' in editing ? editing : undefined}
          defaultDate={'id' in editing ? undefined : editing.date}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            events.reload()
          }}
          onError={setError}
        />
      )}
    </div>
  )
}

function EventForm({
  event,
  defaultDate,
  onClose,
  onSaved,
  onError,
}: {
  event?: CalendarEvent
  defaultDate?: string
  onClose: () => void
  onSaved: () => void
  onError: (m: string) => void
}) {
  const meta = useMeta()
  const garments = useLoad(() => api.garments(), [])
  const [f, setF] = useState<CalendarEventInput>(
    event ?? {
      title: '', kind: 'custom', date: defaultDate ?? localToday(), start_time: null, end_time: null, occasion: null,
      formality: null, labels: [], notes: null, skip_day_routines: null, garment_ids: [],
    },
  )
  const [pickOutfit, setPickOutfit] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof CalendarEventInput>(k: K, v: CalendarEventInput[K]) => setF((p) => ({ ...p, [k]: v }))
  const skipDefault = f.kind === 'holiday' || f.kind === 'travel'

  function chooseKind(kind: EventKind) {
    const d = KIND_DEFAULTS[kind]
    setF((p) => ({
      ...p,
      kind,
      title: p.title || KINDS.find((k) => k.value === kind)!.label,
      occasion: p.occasion ?? d?.occasion ?? null,
      formality: p.formality ?? d?.formality ?? null,
    }))
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const body = { ...f, title: f.title.trim() }
      if (event) await api.updateEvent(event.id, body)
      else await api.createEvent(body)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <Modal
      title={event ? 'Edit event' : 'New event'}
      onClose={onClose}
      wide
      footer={
        <>
          {event && (
            <button
              className="btn btn-danger mr-auto"
              onClick={async () => {
                if (!confirm(`Delete "${event.title}"?`)) return
                try {
                  await api.deleteEvent(event.id)
                  onSaved()
                } catch (e) {
                  onError(e instanceof Error ? e.message : String(e))
                }
              }}
            >
              Delete
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving || !f.title.trim() || !f.date} onClick={save}>Save</button>
        </>
      }
    >
      <ErrorBanner message={error} />
      <span className="label">Kind</span>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            onClick={() => chooseKind(k.value)}
            aria-pressed={f.kind === k.value}
            className={`rounded-full border px-2.5 py-1 text-sm ${f.kind === k.value ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 hover:bg-slate-50'}`}
          >
            {k.icon} {k.label}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="e-title">Title</label>
          <input id="e-title" className="input" value={f.title} onChange={(e) => set('title', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="e-date">Date</label>
          <input id="e-date" type="date" className="input" value={f.date} onChange={(e) => set('date', e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="e-start">From</label>
            <input id="e-start" type="time" className="input" value={f.start_time ?? ''} onChange={(e) => set('start_time', e.target.value || null)} />
          </div>
          <div>
            <label className="label" htmlFor="e-end">To</label>
            <input id="e-end" type="time" className="input" value={f.end_time ?? ''} onChange={(e) => set('end_time', e.target.value || null)} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="e-occ">Dress code: occasion</label>
          <select id="e-occ" className="input" value={f.occasion ?? ''} onChange={(e) => set('occasion', e.target.value || null)}>
            <option value="">None</option>
            {meta.occasions.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="e-form">Dress code: formality</label>
          <select id="e-form" className="input" value={f.formality ?? ''} onChange={(e) => set('formality', e.target.value ? Number(e.target.value) : null)}>
            <option value="">Any</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            className="accent-indigo-600"
            checked={f.skip_day_routines ?? skipDefault}
            onChange={(e) => set('skip_day_routines', e.target.checked)}
          />
          Replaces my usual daytime routines that day (e.g. no office clothes)
        </label>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="e-notes">Notes</label>
          <input id="e-notes" className="input" value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value || null)} />
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="label mb-0">Reserved outfit (optional)</span>
          <button className="text-sm text-indigo-700 hover:underline" onClick={() => setPickOutfit(!pickOutfit)}>
            {pickOutfit ? 'Done' : f.garment_ids.length ? 'Change' : 'Choose garments'}
          </button>
        </div>
        {!pickOutfit && f.garment_ids.length > 0 && (
          <p className="text-sm text-slate-600">
            {f.garment_ids.map((id) => garments.data?.find((g) => g.id === id)?.name).filter(Boolean).join(', ')}
            <span className="block text-xs text-slate-500">The planner keeps these free and clean for this day.</span>
          </p>
        )}
        {!pickOutfit && !f.garment_ids.length && (
          <p className="text-xs text-slate-500">
            Leave empty and the planner picks an outfit {f.occasion || f.formality ? `for the dress code` : 'if you set a dress code'}.
          </p>
        )}
        {pickOutfit && garments.data && (
          <GarmentPicker garments={garments.data} selected={f.garment_ids} onChange={(v) => set('garment_ids', v)} />
        )}
      </div>
      <p className="mt-3 text-xs text-slate-400">{capitalize(f.kind)} events can be edited or deleted any time; saved plans for that day update automatically.</p>
    </Modal>
  )
}
