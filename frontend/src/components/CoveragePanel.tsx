import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAi } from '../App'
import { api } from '../lib/api'
import { categoryTitle, fmtDate, localToday, useLoad } from '../lib/format'
import type { Brief, CoverageSuggestion } from '../lib/types'
import { Icon } from './Icon'
import { ErrorBanner } from './ui'

const TONE = {
  ok: { box: 'border-emerald-200 bg-emerald-50', icon: 'bg-emerald-500', text: 'text-emerald-950' },
  warning: { box: 'border-amber-200 bg-amber-50', icon: 'bg-amber-500', text: 'text-amber-950' },
  alert: { box: 'border-red-200 bg-red-50', icon: 'bg-red-500', text: 'text-red-950' },
  none: { box: 'border-slate-200 bg-white', icon: 'bg-slate-400', text: 'text-slate-800' },
}

/**
 * "Will my clothes last?" Checks routines until the next laundry is back (at least a
 * week), shows shortages, and offers one-click fixes. `compact` is for the Today page.
 */
export function CoveragePanel({ compact = false, onChanged }: { compact?: boolean; onChanged?: () => void }) {
  const ai = useAi()
  const today = localToday()
  const cov = useLoad(() => api.coverage(today), [today])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string[]>([])
  const [brief, setBrief] = useState<Brief | null>(null)
  const [briefing, setBriefing] = useState(false)
  const [showStock, setShowStock] = useState(false)

  if (!cov.data) return cov.error ? <ErrorBanner message={cov.error} /> : null
  const c = cov.data
  const tone = TONE[c.status]

  async function act(s: CoverageSuggestion) {
    setBusy(true)
    setError(null)
    try {
      if (s.kind === 'wash' && s.wash_on) {
        await api.createBasket({ name: `Laundry ${fmtDate(s.wash_on)}`, scheduled_for: s.wash_on, garment_ids: s.garment_ids })
      } else if (s.kind === 'schedule' && s.basket_id && s.wash_on) {
        await api.updateBasket(s.basket_id, { scheduled_for: s.wash_on })
      }
      setDone((d) => [...d, s.title])
      await cov.reload()
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function getBrief() {
    setBriefing(true)
    setError(null)
    try {
      setBrief(await api.brief(today))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBriefing(false)
    }
  }

  const suggestions = compact ? c.suggestions.slice(0, 1) : c.suggestions

  return (
    <section className={`rounded-2xl border p-4 ${tone.box}`}>
      <div className="flex items-start gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white shadow-sm ${tone.icon}`}>
          <Icon name={c.status === 'ok' ? 'check' : c.status === 'none' ? 'repeat' : 'alert'} className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className={`font-semibold ${tone.text}`}>{c.headline}</p>
          {c.status !== 'none' && (
            <p className="text-sm text-slate-600">
              Checked {c.horizon}
              {/* An extended horizon already names the laundry; a plain week doesn't. */}
              {c.next_laundry && c.days === 7 ? ` · next clean laundry ${fmtDate(c.next_laundry)}` : ''}
              {!c.next_laundry ? ' · no laundry scheduled yet' : ''}
            </p>
          )}
          {c.status === 'none' && (
            <Link to="/routines" className="text-sm font-medium text-indigo-700 hover:underline">Add routines →</Link>
          )}
        </div>
        {compact && c.status !== 'none' && (
          <Link to="/plan" className="shrink-0 text-sm font-medium text-indigo-700 hover:underline">Details</Link>
        )}
        {!compact && ai?.enabled && c.status !== 'none' && (
          <button className="btn btn-secondary shrink-0" disabled={briefing} onClick={getBrief}>
            {briefing ? 'Writing…' : '✨ Weekly brief'}
          </button>
        )}
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {!compact && c.shortages.length > 0 && (
        <ul className="mt-3 divide-y divide-black/5 rounded-xl bg-white/70 text-sm">
          {c.shortages.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
              <span className="font-medium">{categoryTitle(s.category)}</span>
              <span className="text-slate-500">{s.routine}</span>
              <span className="ml-auto text-slate-700 tabular-nums">
                {s.available} of {s.required} planned
              </span>
              {s.first_short && <span className="w-full text-xs text-red-700 sm:w-auto">short from {fmtDate(s.first_short)}</span>}
            </li>
          ))}
        </ul>
      )}

      {suggestions.length > 0 && (
        <ul className="mt-3 space-y-2">
          {suggestions.map((s) => (
            <li key={s.title} className="flex flex-wrap items-center gap-3 rounded-xl bg-white/80 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">💡 {s.title}</p>
                <p className="text-xs text-slate-600">{s.detail}</p>
              </div>
              {done.includes(s.title) ? (
                <span className="text-sm text-emerald-700">✓ Done</span>
              ) : s.kind === 'wash' ? (
                <button className="btn btn-primary px-2.5 py-1.5 text-xs" disabled={busy} onClick={() => act(s)}>Create basket</button>
              ) : s.kind === 'schedule' ? (
                <button className="btn btn-primary px-2.5 py-1.5 text-xs" disabled={busy} onClick={() => act(s)}>Schedule it</button>
              ) : (
                <Link to="/insights" className="btn btn-secondary px-2.5 py-1.5 text-xs">Before you buy</Link>
              )}
            </li>
          ))}
        </ul>
      )}

      {brief && (
        <div className="mt-3 rounded-xl bg-white/90 p-3 text-sm">
          <p className="mb-1 font-medium">✨ {brief.summary}</p>
          {brief.bullets.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-slate-700">
              {brief.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {brief.tips.length > 0 && (
            <p className="mt-2 text-xs text-slate-600">
              <span className="font-medium">Tips:</span> {brief.tips.join(' · ')}
            </p>
          )}
        </div>
      )}

      {!compact && c.stock.length > 0 && (
        <div className="mt-3">
          <button className="text-xs font-medium text-slate-600 hover:text-slate-900" onClick={() => setShowStock(!showStock)} aria-expanded={showStock}>
            {showStock ? '▾' : '▸'} Recommended stock per laundry cycle ({c.stock.filter((s) => !s.ok).length} short)
          </button>
          {showStock && (
            <table className="mt-2 w-full rounded-xl bg-white/70 text-sm">
              <tbody className="divide-y divide-black/5">
                {c.stock.map((s, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1.5">{categoryTitle(s.category)}</td>
                    <td className="px-3 py-1.5 text-slate-500">{s.routine}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      own {s.owned} / need {s.needed}
                    </td>
                    <td className="w-8 px-3 py-1.5 text-center">{s.ok ? '✓' : '⚠️'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  )
}
