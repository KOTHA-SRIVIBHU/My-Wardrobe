import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAi, useMeta } from '../App'
import { Empty, ErrorBanner, GarmentThumb, Notice, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { localToday, useLoad } from '../lib/format'
import type { Explanation, Outfit } from '../lib/types'

const FORMALITY = ['Very casual', 'Casual', 'Smart casual', 'Business', 'Formal']

export default function Outfits() {
  const meta = useMeta()
  const labels = useLoad(() => api.labels(), [])
  const [occasion, setOccasion] = useState('')
  const [formality, setFormality] = useState('')
  const [weather, setWeather] = useState<string[]>([])
  // Bumped to re-run generation after an action changes availability.
  const [round, setRound] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])

  const today = localToday()
  // Start from today's forecast (or the user's own report); the chips stay editable.
  useEffect(() => {
    let cancelled = false
    api
      .weather(1, today)
      .then((w) => {
        const tags = w.days[0]?.weather ?? []
        if (!cancelled && tags.length) setWeather((current) => (current.length ? current : tags))
      })
      .catch(() => {
        /* no location or forecast: the user picks weather by hand */
      })
    return () => {
      cancelled = true
    }
  }, [today])
  const result = useLoad(
    () =>
      api.generateOutfits({
        occasion: occasion || null,
        formality: formality ? Number(formality) : null,
        weather,
        count: 6,
        today,
      }),
    [occasion, formality, weather, today, round],
  )
  const occasions = [...new Set([...meta.occasions, ...(labels.data ?? [])])].sort()

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Outfit ideas</h1>
        <p className="text-sm text-slate-500">Built only from clothes that are clean, ironed and ready to wear right now.</p>
      </div>

      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="o-occ">Occasion</label>
          <select id="o-occ" className="input" value={occasion} onChange={(e) => setOccasion(e.target.value)}>
            <option value="">Any</option>
            {occasions.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="o-form">Formality</label>
          <select id="o-form" className="input" value={formality} onChange={(e) => setFormality(e.target.value)}>
            <option value="">Any</option>
            {FORMALITY.map((f, i) => (
              <option key={f} value={i + 1}>{i + 1} · {f}</option>
            ))}
          </select>
        </div>
        <div>
          <span className="label">Weather today</span>
          <div className="flex flex-wrap gap-1.5">
            {meta.weather.map((w) => {
              const on = weather.includes(w)
              return (
                <button
                  key={w}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setWeather(on ? weather.filter((x) => x !== w) : [...weather, w])}
                  className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
                >
                  {w}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <ErrorBanner message={error ?? result.error} onDismiss={() => setError(null)} />
      <Notice messages={[...notices, ...(result.data?.notes ?? [])]} onDismiss={() => setNotices([])} />

      {result.loading && !result.data ? (
        <Spinner />
      ) : result.data?.outfits.length === 0 ? (
        <Empty>
          No outfits are possible with what's ready right now. Check the <Link to="/" className="text-indigo-700 underline">Today page</Link> for
          clothes that are drying or need ironing.
        </Empty>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {result.data?.outfits.map((o) => (
            <OutfitCard
              key={o.garments.map((g) => g.id).join()}
              outfit={o}
              occasion={occasion}
              weather={weather}
              onWorn={() => {
                setNotices(['Marked as worn today. Suggestions updated.'])
                setRound((r) => r + 1)
              }}
              onError={setError}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function OutfitCard({
  outfit,
  occasion,
  weather,
  onWorn,
  onError,
}: {
  outfit: Outfit
  occasion: string
  weather: string[]
  onWorn: () => void
  onError: (m: string) => void
}) {
  const ai = useAi()
  const ids = outfit.garments.map((g) => g.id)
  const [rated, setRated] = useState<1 | -1 | null>(null)
  const [savedPair, setSavedPair] = useState(false)
  const [explaining, setExplaining] = useState(false)
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [explainError, setExplainError] = useState<string | null>(null)

  const fail = (e: unknown) => onError(e instanceof Error ? e.message : String(e))

  async function explain() {
    setExplaining(true)
    setExplainError(null)
    try {
      setExplanation(await api.explainOutfit(ids, occasion || null, weather))
    } catch (e) {
      // AI is optional: show the problem inline and keep the rest of the card usable.
      setExplainError(e instanceof Error ? e.message : String(e))
    } finally {
      setExplaining(false)
    }
  }

  return (
    <li className="card flex flex-col p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {outfit.garments.map((g) => (
            <Link key={g.id} to={`/garments/${g.id}`} className="w-20 text-center" title={g.name}>
              <GarmentThumb garment={g} size="md" />
              <span className="mt-1 block truncate text-xs text-slate-600">{g.name}</span>
            </Link>
          ))}
        </div>
        <span className="shrink-0 rounded-full bg-indigo-50 px-2.5 py-1 text-sm font-semibold text-indigo-700 tabular-nums" title="Match score">
          {outfit.score}
        </span>
      </div>

      <ul className="mb-3 space-y-0.5 text-sm">
        {outfit.reasons.map((r) => (
          <li key={r} className="text-emerald-800">✓ {r}</li>
        ))}
        {outfit.cautions.map((c) => (
          <li key={c} className="text-amber-800">! {c}</li>
        ))}
      </ul>

      {explanation && (
        <div className="mb-3 rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-950">
          <p>{explanation.summary}</p>
          {explanation.tips.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {explanation.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {explainError && <p className="mb-3 text-sm text-slate-500">{explainError}</p>}

      <div className="mt-auto flex flex-wrap items-center gap-2">
        <button
          className="btn btn-primary"
          onClick={async () => {
            try {
              await api.wear(ids, localToday())
              onWorn()
            } catch (e) {
              fail(e)
            }
          }}
        >
          Wear today
        </button>
        <button
          className="btn btn-secondary"
          disabled={savedPair}
          onClick={async () => {
            const name = prompt('Name this pair', outfit.garments.map((g) => g.name).join(' + ').slice(0, 120))
            if (!name) return
            try {
              await api.createPair({ name, garment_ids: ids, labels: occasion ? [occasion] : [], occasion: occasion || null })
              setSavedPair(true)
            } catch (e) {
              fail(e)
            }
          }}
        >
          {savedPair ? 'Saved as pair' : 'Save as pair'}
        </button>
        {ai?.enabled && !explanation && (
          <button className="btn btn-secondary" disabled={explaining} onClick={explain}>
            {explaining ? 'Thinking…' : '✨ Why this works'}
          </button>
        )}
        <span className="ml-auto flex gap-1">
          {([1, -1] as const).map((r) => (
            <button
              key={r}
              aria-label={r === 1 ? 'I like this' : 'Not for me'}
              aria-pressed={rated === r}
              disabled={rated !== null || ids.length < 2}
              className={`rounded-lg px-2 py-1 text-lg ${rated === r ? 'bg-indigo-100' : 'hover:bg-slate-100'} disabled:cursor-default`}
              onClick={async () => {
                try {
                  await api.outfitFeedback(ids, r)
                  setRated(r)
                } catch (e) {
                  fail(e)
                }
              }}
            >
              {r === 1 ? '👍' : '👎'}
            </button>
          ))}
        </span>
      </div>
    </li>
  )
}
