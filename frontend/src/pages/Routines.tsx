import { useState } from 'react'
import { useAi, useMeta } from '../App'
import { Chip, Empty, ErrorBanner, IssueList, Modal, Spinner, WeekdayPicker } from '../components/ui'
import { api } from '../lib/api'
import { capitalize, useLoad, weekdaysText } from '../lib/format'
import type { Feasibility, Requirement, RoutineDraft, RoutineInput } from '../lib/types'

const EXAMPLE =
  'Monday to Friday I go to the office. Every day I need one formal shirt, one vest, one pair of underwear and one pair of socks. I use the same office shoes all month. Every night I wear a nightwear set.'

function blank(): RoutineInput {
  return {
    name: '', kind: 'day', weekdays: [0, 1, 2, 3, 4], start_date: null, end_date: null, occasion: null,
    formality: null, requirements: [newRequirement()], mandatory: true, active: true, notes: null, source_text: null,
  }
}

function newRequirement(category = 'shirt'): Requirement {
  return { category, quantity: 1, labels: [], min_formality: null, reuse: 'rotate', no_consecutive: false }
}

function fromDraft(d: RoutineDraft, text: string): RoutineInput {
  return { ...blank(), ...d, source_text: text }
}

function describeRequirement(r: Requirement): string {
  const extras = [
    r.min_formality ? `formality ${r.min_formality}+` : '',
    r.reuse === 'fixed' ? 'same item' : '',
    r.no_consecutive ? 'not two days running' : '',
    r.labels.length ? r.labels.join('/') : '',
  ].filter(Boolean)
  return `${r.quantity} × ${r.category}${extras.length ? ` (${extras.join(', ')})` : ''}`
}

export default function Routines() {
  const ai = useAi()
  const routines = useLoad(() => api.routines(), [])
  const [text, setText] = useState('')
  const [interpreting, setInterpreting] = useState(false)
  const [drafts, setDrafts] = useState<RoutineDraft[]>([])
  const [questions, setQuestions] = useState<string[]>([])
  const [editing, setEditing] = useState<{ routine: RoutineInput; id?: string; draftIndex?: number } | null>(null)
  const [check, setCheck] = useState<Feasibility | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function interpret() {
    setInterpreting(true)
    setError(null)
    try {
      const r = await api.interpretRoutines(text)
      setDrafts(r.routines)
      setQuestions(r.questions)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInterpreting(false)
    }
  }

  async function runCheck() {
    setChecking(true)
    setError(null)
    try {
      setCheck(await api.checkRoutines())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setChecking(false)
    }
  }

  async function run(action: () => Promise<unknown>) {
    setError(null)
    try {
      await action()
      routines.reload()
      setCheck(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Routines</h1>
          <p className="text-sm text-slate-500">What you need to wear on a normal week. The planner fills each day from these.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing({ routine: blank() })}>
          + Add routine
        </button>
      </div>
      <ErrorBanner message={error ?? routines.error} onDismiss={() => setError(null)} />

      <section className="card p-4">
        <h2 className="mb-1 font-semibold">Describe your routine</h2>
        <p className="mb-3 text-sm text-slate-500">Write it the way you'd tell a friend. You'll review everything before it's saved.</p>
        <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {ai?.enabled ? (
            <button className="btn btn-primary" disabled={interpreting || text.trim().length < 3} onClick={interpret}>
              {interpreting ? 'Reading…' : '✨ Turn into routines'}
            </button>
          ) : (
            <p className="text-sm text-slate-500">AI is off, so add routines with the form instead (+ Add routine).</p>
          )}
          {!text && (
            <button className="text-sm text-indigo-700 hover:underline" onClick={() => setText(EXAMPLE)}>
              Use the example
            </button>
          )}
        </div>
        {questions.length > 0 && (
          <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="mb-1 font-medium">A few things to clarify (edit your text and try again, or fix them below):</p>
            <ul className="list-disc pl-5">
              {questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </div>
        )}
        {drafts.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-sm font-medium text-slate-700">Here's what I understood. Review each one to save it:</p>
            {drafts.map((d, i) => (
              <div key={i} className="flex flex-wrap items-center gap-3 rounded-lg border border-indigo-200 bg-indigo-50/50 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {d.name} <span className="text-xs font-normal text-slate-500">· {d.kind === 'night' ? 'night' : 'day'} · {weekdaysText(d.weekdays)}</span>
                  </p>
                  <p className="text-sm text-slate-600">{d.requirements.map(describeRequirement).join(' · ') || 'No items yet'}</p>
                </div>
                <button className="btn btn-primary" onClick={() => setEditing({ routine: fromDraft(d, text), draftIndex: i })}>
                  Review & save
                </button>
                <button className="btn btn-secondary" onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}>
                  Discard
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">Your routines</h2>
          {(routines.data?.length ?? 0) > 0 && (
            <button className="btn btn-secondary" disabled={checking} onClick={runCheck}>
              {checking ? 'Checking…' : 'Can my wardrobe cover these?'}
            </button>
          )}
        </div>
        {check && (
          <div className="mb-3">
            {check.ok && check.issues.length === 0 ? (
              <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                ✓ Your wardrobe covers all routines for the next {check.days} days.
              </p>
            ) : (
              <IssueList issues={check.issues} />
            )}
          </div>
        )}
        {routines.loading && !routines.data ? (
          <Spinner />
        ) : routines.data?.length === 0 ? (
          <Empty>No routines yet. Describe your week above, or add one by hand.</Empty>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {routines.data?.map((r) => (
              <li key={r.id} className={`card p-4 ${r.active ? '' : 'opacity-60'}`}>
                <div className="mb-1 flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold">
                      {r.kind === 'night' ? '🌙 ' : ''}
                      {r.name}
                    </h3>
                    <p className="text-xs text-slate-500">
                      {weekdaysText(r.weekdays)}
                      {r.occasion ? ` · ${r.occasion}` : ''}
                      {r.mandatory ? '' : ' · flexible'}
                      {r.active ? '' : ' · paused'}
                    </p>
                  </div>
                </div>
                <ul className="mb-3 text-sm text-slate-700">
                  {r.requirements.map((q, i) => (
                    <li key={i}>• {describeRequirement(q)}</li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-secondary" onClick={() => setEditing({ routine: r, id: r.id })}>Edit</button>
                  <button className="btn btn-secondary" onClick={() => run(() => api.updateRoutine(r.id, { ...r, active: !r.active }))}>
                    {r.active ? 'Pause' : 'Resume'}
                  </button>
                  <button className="btn btn-danger" onClick={() => confirm(`Delete "${r.name}"?`) && run(() => api.deleteRoutine(r.id))}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <RoutineForm
          initial={editing.routine}
          id={editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            if (editing.draftIndex !== undefined) setDrafts(drafts.filter((_, j) => j !== editing.draftIndex))
            setEditing(null)
            routines.reload()
            setCheck(null)
          }}
        />
      )}
    </div>
  )
}

function RoutineForm({
  initial,
  id,
  onClose,
  onSaved,
}: {
  initial: RoutineInput
  id?: string
  onClose: () => void
  onSaved: () => void
}) {
  const meta = useMeta()
  const [r, setR] = useState<RoutineInput>({ ...initial, requirements: initial.requirements.map((q) => ({ ...q })) })
  const [error, setError] = useState<string | null>(null)
  const [check, setCheck] = useState<Feasibility | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof RoutineInput>(k: K, v: RoutineInput[K]) => setR((p) => ({ ...p, [k]: v }))
  const setReq = (i: number, patch: Partial<Requirement>) =>
    set('requirements', r.requirements.map((q, j) => (j === i ? { ...q, ...patch } : q)))

  const invalid = !r.name.trim() ? 'Give the routine a name' : !r.weekdays.length ? 'Pick at least one day' : !r.requirements.length ? 'Add at least one item' : null
  const body = (): RoutineInput => ({ ...r, name: r.name.trim() })

  async function save() {
    setBusy(true)
    setError(null)
    try {
      if (id) await api.updateRoutine(id, body())
      else await api.createRoutine(body())
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  async function runCheck() {
    setBusy(true)
    setError(null)
    try {
      setCheck(await api.checkRoutines(body(), id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={id ? `Edit ${initial.name}` : 'Routine'}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="mr-auto self-center text-xs text-slate-500">{invalid}</span>
          <button className="btn btn-secondary" disabled={busy || !!invalid} onClick={runCheck}>Check wardrobe</button>
          <button className="btn btn-primary" disabled={busy || !!invalid} onClick={save}>Save routine</button>
        </>
      }
    >
      <ErrorBanner message={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="r-name">Name</label>
          <input id="r-name" className="input" value={r.name} onChange={(e) => set('name', e.target.value)} placeholder="Office days" />
        </div>
        <div>
          <span className="label">When</span>
          <div className="flex gap-1.5">
            <Chip on={r.kind === 'day'} onClick={() => set('kind', 'day')}>☀️ Daytime</Chip>
            <Chip on={r.kind === 'night'} onClick={() => set('kind', 'night')}>🌙 Night</Chip>
          </div>
        </div>
        <div className="sm:col-span-2">
          <span className="label">Days</span>
          <WeekdayPicker value={r.weekdays} onChange={(v) => set('weekdays', v)} />
        </div>
        <div>
          <label className="label" htmlFor="r-occ">Occasion</label>
          <select id="r-occ" className="input" value={r.occasion ?? ''} onChange={(e) => set('occasion', e.target.value || null)}>
            <option value="">None</option>
            {meta.occasions.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="r-form">Formality</label>
          <select id="r-form" className="input" value={r.formality ?? ''} onChange={(e) => set('formality', e.target.value ? Number(e.target.value) : null)}>
            <option value="">Any</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="r-start">From (optional)</label>
          <input id="r-start" type="date" className="input" value={r.start_date ?? ''} onChange={(e) => set('start_date', e.target.value || null)} />
        </div>
        <div>
          <label className="label" htmlFor="r-end">Until (optional)</label>
          <input id="r-end" type="date" className="input" value={r.end_date ?? ''} onChange={(e) => set('end_date', e.target.value || null)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-indigo-600" checked={r.mandatory} onChange={(e) => set('mandatory', e.target.checked)} />
          Must be covered (shortages are errors)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-indigo-600" checked={r.active} onChange={(e) => set('active', e.target.checked)} />
          Active
        </label>
      </div>

      <h3 className="mt-5 mb-2 text-sm font-semibold">Items needed each day</h3>
      <ul className="space-y-2">
        {r.requirements.map((q, i) => (
          <li key={i} className="grid grid-cols-2 items-end gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-6">
            <div className="sm:col-span-2">
              <label className="label" htmlFor={`q-cat-${i}`}>Category</label>
              <select id={`q-cat-${i}`} className="input" value={q.category} onChange={(e) => setReq(i, { category: e.target.value })}>
                {[...new Set([...meta.categories.map((c) => c.value), q.category])].map((c) => (
                  <option key={c} value={c}>{capitalize(c)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor={`q-qty-${i}`}>How many</label>
              <input id={`q-qty-${i}`} type="number" min={1} max={10} className="input" value={q.quantity} onChange={(e) => setReq(i, { quantity: Math.max(1, Number(e.target.value) || 1) })} />
            </div>
            <div>
              <label className="label" htmlFor={`q-min-${i}`}>Min. formality</label>
              <select id={`q-min-${i}`} className="input" value={q.min_formality ?? ''} onChange={(e) => setReq(i, { min_formality: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Any</option>
                {[2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n}+</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor={`q-reuse-${i}`}>Choose</label>
              <select id={`q-reuse-${i}`} className="input" value={q.reuse} onChange={(e) => setReq(i, { reuse: e.target.value as Requirement['reuse'] })}>
                <option value="rotate">Rotate</option>
                <option value="fixed">Same item</option>
              </select>
            </div>
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" className="accent-indigo-600" checked={q.no_consecutive} onChange={(e) => setReq(i, { no_consecutive: e.target.checked })} />
                Not 2 days running
              </label>
              <button className="text-red-600 hover:text-red-800" aria-label="Remove item" onClick={() => set('requirements', r.requirements.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button className="btn btn-secondary mt-2" onClick={() => set('requirements', [...r.requirements, newRequirement('socks')])}>
        + Add item
      </button>

      {check && (
        <div className="mt-4">
          {check.ok && check.issues.length === 0 ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              ✓ Your wardrobe can cover this (with your other routines) for the next {check.days} days.
            </p>
          ) : (
            <IssueList issues={check.issues} />
          )}
        </div>
      )}
    </Modal>
  )
}
