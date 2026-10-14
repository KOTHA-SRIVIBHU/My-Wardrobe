import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMeta } from '../App'
import { CoveragePanel } from '../components/CoveragePanel'
import { GarmentPicker } from '../components/GarmentPicker'
import { Chip, Empty, ErrorBanner, GarmentThumb, IssueList, Modal, Spinner, WeekdayPicker } from '../components/ui'
import { api } from '../lib/api'
import { addDays, fmtDate, localToday, plural, useLoad } from '../lib/format'
import type { Plan as PlanData, PlanDay, PlanSlot, Settings } from '../lib/types'

export default function Plan() {
  const today = localToday()
  const [start, setStart] = useState(today)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [covKey, setCovKey] = useState(0)
  const plan = useLoad(() => api.plan(start, 7, today), [start, today])
  const routines = useLoad(() => api.routines(), [])

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      const r = await action()
      if (r && typeof r === 'object' && 'days' in r) plan.setData(r as PlanData)
      else await plan.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setCovKey((k) => k + 1) // plan changes can change coverage
    }
  }

  const p = plan.data
  const noRoutines = routines.data?.length === 0

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Plan</h1>
          <p className="text-sm text-slate-500">
            Your week, built from routines, events, weather and what's actually clean.
            {p?.location ? ` Weather for ${p.location}.` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-secondary" onClick={() => setSettingsOpen(true)}>⚙ Settings</button>
          <button className="btn btn-primary" disabled={busy || !p} onClick={() => run(() => api.generatePlan(start, 7, today))}>
            {p?.has_plan ? 'Re-plan unlocked days' : 'Save this plan'}
          </button>
        </div>
      </div>

      <div className="mb-5">
        <CoveragePanel key={covKey} onChanged={() => plan.reload()} />
      </div>

      <div className="mb-4 flex items-center gap-2">
        <button className="btn btn-secondary" disabled={start <= today} onClick={() => setStart(start <= addDays(today, 7) ? today : addDays(start, -7))}>
          ←
        </button>
        <span className="text-sm font-medium">
          {fmtDate(start)} – {fmtDate(addDays(start, 6))}
        </span>
        <button className="btn btn-secondary" disabled={start >= addDays(today, 21)} onClick={() => setStart(addDays(start, 7))}>
          →
        </button>
        {start !== today && (
          <button className="text-sm text-indigo-700 hover:underline" onClick={() => setStart(today)}>This week</button>
        )}
      </div>

      <ErrorBanner message={error ?? plan.error} onDismiss={() => setError(null)} />

      {noRoutines && (
        <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
          Add your <Link to="/routines" className="font-medium underline">routines</Link> (e.g. office days, nightwear) so the planner knows what you need each day.
        </div>
      )}
      {p && !p.has_plan && !noRoutines && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          These are live suggestions. <strong>Save this plan</strong> to keep them steady, then lock any day you want to keep exactly as it is.
        </div>
      )}
      {p && p.affected_dates.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>
            {plural(p.affected_dates.length, 'planned day')} changed because of laundry or wardrobe updates ({p.affected_dates.map(fmtDate).join(', ')}).
          </span>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.generatePlan(start, 7, today, p.affected_dates))}>
            Update {p.affected_dates.length === 1 ? 'it' : 'them'}
          </button>
        </div>
      )}
      {p && !p.location && (
        <p className="mb-4 text-sm text-slate-500">
          Tip: set your location in <button className="text-indigo-700 underline" onClick={() => setSettingsOpen(true)}>settings</button> to plan around the weather.
        </p>
      )}
      {p?.weather_error && <p className="mb-4 text-sm text-slate-500">{p.weather_error}</p>}
      {p && p.issues.length > 0 && (
        <div className="mb-4">
          <IssueList issues={p.issues} />
        </div>
      )}

      {plan.loading && !p ? (
        <Spinner />
      ) : p && p.days.every((d) => d.slots.length === 0 && d.events.length === 0) ? (
        <Empty>Nothing to plan this week yet.</Empty>
      ) : (
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {p?.days.map((d) => (
            <DayCard key={d.date} day={d} today={today} busy={busy} run={run} />
          ))}
        </ol>
      )}

      {settingsOpen && (
        <PlanSettings
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false)
            plan.reload()
          }}
        />
      )}
    </div>
  )
}

function DayCard({
  day,
  today,
  busy,
  run,
}: {
  day: PlanDay
  today: string
  busy: boolean
  run: (a: () => Promise<unknown>) => void
}) {
  const meta = useMeta()
  const [reporting, setReporting] = useState(false)
  const label = day.date === today ? 'Today' : day.date === addDays(today, 1) ? 'Tomorrow' : fmtDate(day.date)
  const fc = day.forecast

  return (
    <li className="card flex flex-col p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{label}</h2>
          {label !== fmtDate(day.date) && <p className="text-xs text-slate-500">{fmtDate(day.date)}</p>}
        </div>
        <button className="text-right text-xs text-slate-600 hover:text-indigo-700" onClick={() => setReporting(!reporting)} title="Report today's conditions">
          {fc && fc.temp_max !== null && (
            <span className="block tabular-nums">
              {Math.round(fc.temp_max)}° / {Math.round(fc.temp_min ?? fc.temp_max)}°
            </span>
          )}
          <span>{day.weather.join(', ') || 'Weather?'}</span>
          {day.reported.length > 0 && <span className="block text-indigo-600">(your report)</span>}
        </button>
      </div>
      {reporting && (
        <div className="mb-3 rounded-lg bg-slate-50 p-2">
          <p className="mb-1.5 text-xs text-slate-600">How does it feel? This guides the plan without replacing the forecast.</p>
          <div className="flex flex-wrap gap-1">
            {meta.weather.map((w) => {
              const on = day.reported.includes(w)
              return (
                <Chip key={w} on={on} onClick={() => run(() => api.reportWeather(day.date, on ? day.reported.filter((x) => x !== w) : [...day.reported, w]))}>
                  {w}
                </Chip>
              )
            })}
          </div>
        </div>
      )}

      {day.events.map((e) => (
        <p key={e.id} className="mb-2 rounded-lg bg-violet-50 px-2.5 py-1.5 text-xs text-violet-900">
          📅 {e.title}
          {e.start_time ? ` · ${e.start_time}` : ''}
          {e.skip_day_routines ? ' · usual routines off' : ''}
        </p>
      ))}

      {day.slots.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing planned.</p>
      ) : (
        <ul className="space-y-3">
          {day.slots.map((s) => (
            <SlotRow key={s.key} slot={s} date={day.date} today={today} busy={busy} run={run} />
          ))}
        </ul>
      )}
    </li>
  )
}

function SlotRow({
  slot,
  date,
  today,
  busy,
  run,
}: {
  slot: PlanSlot
  date: string
  today: string
  busy: boolean
  run: (a: () => Promise<unknown>) => void
}) {
  const [changing, setChanging] = useState(false)
  const ids = slot.garments.map((g) => g.id)

  // Unsaved suggestions are stored on first interaction so they can be locked/worn.
  const ensureSaved = async (locked: boolean): Promise<string> => {
    if (slot.entry_id) return slot.entry_id
    const r = await api.saveEntry({ date, slot_key: slot.key, title: slot.title, garment_ids: ids, locked })
    return r.id
  }

  const toggleLock = () =>
    run(async () => {
      if (slot.entry_id) await api.updateEntry(slot.entry_id, { locked: !slot.locked })
      else await ensureSaved(true)
    })

  const wear = () =>
    run(async () => {
      const id = await ensureSaved(slot.locked)
      await api.wearEntry(id, today)
    })

  return (
    <li className={`rounded-lg border p-2.5 ${slot.problems.length ? 'border-red-200' : 'border-slate-200'} ${slot.status !== 'planned' ? 'opacity-60' : ''}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {slot.source === 'event' ? '📅 ' : ''}
          {slot.title}
        </span>
        {slot.status === 'worn' && <span className="text-xs text-emerald-700">✓ worn</span>}
        {!slot.saved && slot.garments.length > 0 && <span className="text-xs text-slate-400">suggested</span>}
        {slot.status === 'planned' && slot.garments.length > 0 && (
          <button
            className={`rounded px-1.5 text-sm ${slot.locked ? 'bg-indigo-100 text-indigo-700' : 'text-slate-400 hover:text-slate-700'}`}
            disabled={busy}
            onClick={toggleLock}
            aria-pressed={slot.locked}
            title={slot.locked ? 'Locked: kept when re-planning' : 'Lock this outfit'}
          >
            {slot.locked ? '🔒' : '🔓'}
          </button>
        )}
      </div>
      {slot.garments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {slot.garments.map((g) => (
            <Link key={g.id} to={`/garments/${g.id}`} title={g.name} className="w-14 text-center">
              <GarmentThumb garment={g} size="sm" />
              <span className="block truncate text-[10px] text-slate-600">{g.name}</span>
            </Link>
          ))}
        </div>
      )}
      {slot.prep.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-amber-800">
          {slot.prep.map((t) => (
            <li key={t}>• {t}</li>
          ))}
        </ul>
      )}
      {slot.problems.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-red-700">
          {slot.problems.map((t) => (
            <li key={t}>! {t}</li>
          ))}
        </ul>
      )}
      {slot.status === 'planned' && (
        <div className="mt-2 flex gap-3 text-xs">
          <button className="text-indigo-700 hover:underline" onClick={() => setChanging(true)}>Change…</button>
          {date <= today && slot.garments.length > 0 && !slot.problems.length && (
            <button className="text-indigo-700 hover:underline" disabled={busy} onClick={wear}>Wore this</button>
          )}
        </div>
      )}
      {changing && (
        <ChangeOutfit
          title={`${slot.title} · ${fmtDate(date)}`}
          selected={ids}
          onClose={() => setChanging(false)}
          onSave={(garmentIds) => {
            setChanging(false)
            run(async () => {
              if (slot.entry_id) await api.updateEntry(slot.entry_id, { garment_ids: garmentIds })
              else await api.saveEntry({ date, slot_key: slot.key, title: slot.title, garment_ids: garmentIds, locked: true })
            })
          }}
        />
      )}
    </li>
  )
}

function ChangeOutfit({
  title,
  selected,
  onClose,
  onSave,
}: {
  title: string
  selected: string[]
  onClose: () => void
  onSave: (ids: string[]) => void
}) {
  const garments = useLoad(() => api.garments(), [])
  const [ids, setIds] = useState(selected)
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="mr-auto self-center text-xs text-slate-500">Your choice is locked so re-planning won't replace it.</span>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ids.length} onClick={() => onSave(ids)}>Save outfit</button>
        </>
      }
    >
      {garments.data ? <GarmentPicker garments={garments.data} selected={ids} onChange={setIds} /> : <Spinner />}
    </Modal>
  )
}

function PlanSettings({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const current = useLoad(() => api.settings(), [])
  const [draft, setDraft] = useState<Settings | null>(null)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<{ name: string; latitude: number; longitude: number }[]>([])
  const [error, setError] = useState<string | null>(null)
  const s = draft ?? current.data
  const set = (patch: Partial<Settings>) => s && setDraft({ ...s, ...patch })

  async function search() {
    setError(null)
    try {
      const r = await api.geocode(q)
      setResults(r)
      if (!r.length) setError('No places found.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function save() {
    if (!s) return
    try {
      await api.saveSettings(s)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal
      title="Plan settings"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!s} onClick={save}>Save</button>
        </>
      }
    >
      <ErrorBanner message={error ?? current.error} />
      {!s ? (
        <Spinner />
      ) : (
        <div className="space-y-5">
          <div>
            <span className="label">Location (for the weather forecast)</span>
            <p className="mb-2 text-sm">{s.location_name ?? <span className="text-slate-500">Not set</span>}</p>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                search()
              }}
            >
              <input className="input" placeholder="Search a city" value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="btn btn-secondary" disabled={q.trim().length < 2}>Search</button>
            </form>
            {results.length > 0 && (
              <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                {results.map((r) => (
                  <li key={`${r.latitude},${r.longitude}`}>
                    <button
                      className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                      onClick={() => {
                        set({ location_name: r.name, latitude: r.latitude, longitude: r.longitude })
                        setResults([])
                        setQ('')
                      }}
                    >
                      {r.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {s.location_name && (
              <button className="mt-1 text-xs text-slate-500 hover:underline" onClick={() => set({ location_name: null, latitude: null, longitude: null })}>
                Clear location
              </button>
            )}
          </div>
          <div>
            <span className="label">Usual laundry days</span>
            <p className="mb-2 text-xs text-slate-500">The planner assumes everything that needs washing is washed on these days.</p>
            <WeekdayPicker value={s.laundry_weekdays} onChange={(v) => set({ laundry_weekdays: v })} />
          </div>
          <div>
            <label className="label" htmlFor="dry-days">Drying time</label>
            <select id="dry-days" className="input max-w-48" value={s.drying_days} onChange={(e) => set({ drying_days: Number(e.target.value) })}>
              <option value={0}>Same day</option>
              <option value={1}>1 day</option>
              <option value={2}>2 days</option>
              <option value={3}>3 days</option>
            </select>
          </div>
        </div>
      )}
    </Modal>
  )
}
