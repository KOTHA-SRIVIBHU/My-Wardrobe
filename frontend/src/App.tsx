import { App as CapApp } from '@capacitor/app'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Icon, type IconName } from './components/Icon'
import { Reminders } from './components/Reminders'
import { ErrorBanner, Spinner } from './components/ui'
import { ApiError } from './engine/errors'
import { api } from './lib/api'
import { type Connection, activate, currentConnection, isNative, loadConnection, useConnection } from './lib/connection'
import { lockEnabled, onNotificationTap, rescheduleNotifications, unlockApp } from './lib/device'
import { useLoad } from './lib/format'
import type { AiStatus, Meta } from './lib/types'
import BasketDetail from './pages/BasketDetail'
import Calendar from './pages/Calendar'
import GarmentDetail from './pages/GarmentDetail'
import Home from './pages/Home'
import Insights from './pages/Insights'
import Laundry from './pages/Laundry'
import Outfits from './pages/Outfits'
import Pairs from './pages/Pairs'
import Plan from './pages/Plan'
import Privacy from './pages/Privacy'
import Routines from './pages/Routines'
import SettingsPage from './pages/Settings'
import Setup, { Shell as SetupShell } from './pages/Setup'
import Wardrobe from './pages/Wardrobe'

const MetaContext = createContext<Meta | null>(null)
const AiContext = createContext<AiStatus | null>(null)

export function useMeta(): Meta {
  const meta = useContext(MetaContext)
  if (!meta) throw new Error('useMeta outside MetaContext')
  return meta
}

/** Null while loading: treat as AI unavailable. */
export function useAi(): AiStatus | null {
  return useContext(AiContext)
}

type NavItem = { to: string; label: string; icon: IconName; end?: boolean }

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Daily',
    items: [
      { to: '/', label: 'Today', icon: 'home', end: true },
      { to: '/plan', label: 'Plan', icon: 'plan' },
      { to: '/outfits', label: 'Outfits', icon: 'sparkle' },
    ],
  },
  {
    title: 'Wardrobe',
    items: [
      { to: '/wardrobe', label: 'Wardrobe', icon: 'hanger' },
      { to: '/pairs', label: 'Pairs', icon: 'layers' },
      { to: '/laundry', label: 'Laundry', icon: 'washer' },
    ],
  },
  {
    title: 'Planning',
    items: [
      { to: '/routines', label: 'Routines', icon: 'repeat' },
      { to: '/calendar', label: 'Calendar', icon: 'calendar' },
      { to: '/insights', label: 'Insights', icon: 'chart' },
      { to: '/settings', label: 'Settings', icon: 'gear' },
    ],
  },
]
const TABS: NavItem[] = [
  { to: '/', label: 'Today', icon: 'home', end: true },
  { to: '/plan', label: 'Plan', icon: 'plan' },
  { to: '/wardrobe', label: 'Wardrobe', icon: 'hanger' },
  { to: '/laundry', label: 'Laundry', icon: 'washer' },
]
const MORE = NAV_GROUPS.flatMap((g) => g.items).filter((n) => !TABS.some((t) => t.to === n.to))

function Brand() {
  return (
    <span className="flex items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm">
        <Icon name="hanger" className="h-5 w-5" />
      </span>
      <span className="text-lg font-bold tracking-tight text-slate-900">
        Closet<span className="text-indigo-600">IQ</span>
      </span>
    </span>
  )
}

type Phase =
  | { kind: 'booting' }
  | { kind: 'locked' }
  | { kind: 'setup'; initial?: Partial<Connection> }
  | { kind: 'problem'; error: ApiError | Error; connection: Connection }
  | { kind: 'ready' }

const RELOCK_AFTER_MS = 2 * 60 * 1000

export default function App() {
  const location = useLocation()
  const [phase, setPhase] = useState<Phase>({ kind: 'booting' })
  const backgroundedAt = useRef<number | null>(null)

  const open = useCallback(async () => {
    setPhase({ kind: 'booting' })
    const saved = await loadConnection()
    if (!saved) return setPhase({ kind: 'setup' })
    if (await lockEnabled()) {
      setPhase({ kind: 'locked' })
      if (!(await unlockApp())) return
      setPhase({ kind: 'booting' })
    }
    try {
      await activate(saved)
      setPhase({ kind: 'ready' })
    } catch (e) {
      setPhase({ kind: 'problem', error: e as Error, connection: saved })
    }
  }, [])

  useEffect(() => {
    void open()
  }, [open])

  // Coming back to the app: refresh data, re-lock after a while away.
  useEffect(() => {
    if (!isNative) return
    const sub = CapApp.addListener('appStateChange', async ({ isActive }) => {
      if (!isActive) {
        backgroundedAt.current = Date.now()
        return
      }
      const away = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0
      backgroundedAt.current = null
      if (away > RELOCK_AFTER_MS && (await lockEnabled())) {
        setPhase({ kind: 'locked' })
        if (await unlockApp()) setPhase({ kind: 'ready' })
        return
      }
      if (currentConnection()) {
        try {
          const { getService } = await import('./lib/connection')
          await getService().reload()
          void rescheduleNotifications(getService())
        } catch {
          /* offline: keep showing what we have */
        }
      }
    })
    return () => void sub.then((s) => s.remove())
  }, [])

  if (location.pathname === '/privacy') return <Privacy />
  if (phase.kind === 'booting') return <Splash />
  if (phase.kind === 'locked') {
    return (
      <SetupShell>
        <div className="space-y-4 py-6 text-center">
          <Icon name="lock" className="mx-auto h-10 w-10 text-indigo-500" />
          <p className="font-medium">ClosetIQ is locked</p>
          <button className="btn btn-primary w-full" onClick={() => void open()}>Unlock</button>
        </div>
      </SetupShell>
    )
  }
  if (phase.kind === 'setup') return <Setup initial={phase.initial} onDone={() => setPhase({ kind: 'ready' })} />
  if (phase.kind === 'problem') return <Problem error={phase.error} connection={phase.connection} retry={open} edit={(c) => setPhase({ kind: 'setup', initial: c })} />
  return <Shell />
}

function Splash() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50">
      <span className="flex h-14 w-14 animate-pulse items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow">
        <Icon name="hanger" className="h-8 w-8" />
      </span>
      <p className="text-sm text-slate-500">Opening your wardrobe…</p>
    </div>
  )
}

function Problem({ error, connection, retry, edit }: { error: Error; connection: Connection; retry: () => void; edit: (c: Partial<Connection>) => void }) {
  const code = error instanceof ApiError ? error.code : undefined
  const offline = typeof navigator !== 'undefined' && !navigator.onLine
  const title = offline
    ? "You're offline"
    : code === 'passphrase'
      ? 'Your vault passphrase changed'
      : code === 'not_installed' || code === 'schema_outdated'
        ? 'Supabase setup needed'
        : "Couldn't open your wardrobe"
  return (
    <SetupShell>
      <h1 className="text-lg font-semibold">{title}</h1>
      <ErrorBanner message={offline ? 'Connect to the internet and try again.' : error.message} />
      {code === 'passphrase' && <p className="text-sm text-slate-600">It was probably changed on another device. Enter the new one to continue.</p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary flex-1" onClick={retry}>Try again</button>
        <button className="btn btn-secondary flex-1" onClick={() => edit({ ...connection, passphrase: '' })}>
          {code === 'passphrase' ? 'Enter passphrase' : 'Check connection details'}
        </button>
      </div>
    </SetupShell>
  )
}

function Shell() {
  const { connection } = useConnection()
  const navigate = useNavigate()
  const location = useLocation()
  const meta = useLoad(() => api.meta(), [connection?.supabaseUrl])
  const ai = useLoad(() => api.aiStatus(), [connection?.groqKey, connection?.textModel, connection?.visionModel])
  const [moreOpen, setMoreOpen] = useState(false)

  // Android back button: go back, or leave the app from the home screen.
  useEffect(() => {
    if (!isNative) return
    const sub = CapApp.addListener('backButton', ({ canGoBack }) => {
      if (moreOpen) setMoreOpen(false)
      else if (canGoBack && location.pathname !== '/') navigate(-1)
      else void CapApp.exitApp()
    })
    return () => void sub.then((s) => s.remove())
  }, [navigate, location.pathname, moreOpen])

  useEffect(() => onNotificationTap(navigate), [navigate])

  // Keep phone reminders in step with the data (debounced after each change).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsub: (() => void) | undefined
    void import('./lib/connection').then(({ getService }) => {
      const svc = getService()
      void rescheduleNotifications(svc)
      unsub = svc.subscribe(() => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void rescheduleNotifications(svc), 3000)
      })
    })
    return () => {
      unsub?.()
      if (timer) clearTimeout(timer)
    }
  }, [connection?.supabaseUrl])

  useEffect(() => setMoreOpen(false), [location.pathname])
  const inMore = MORE.some((n) => location.pathname.startsWith(n.to))

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Desktop / tablet: sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-slate-200 bg-white lg:flex">
        <div className="px-5 py-5">
          <Brand />
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="mb-1 px-3 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{group.title}</p>
              <ul className="space-y-0.5">
                {group.items.map((n) => (
                  <li key={n.to}>
                    <NavLink
                      to={n.to}
                      end={n.end}
                      className={({ isActive }) =>
                        `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`
                      }
                    >
                      <Icon name={n.icon} />
                      {n.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <NavLink to="/privacy" className="mx-6 mb-4 block text-xs text-slate-400 hover:text-slate-600">Privacy &amp; data</NavLink>
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 pt-[env(safe-area-inset-top)] backdrop-blur">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 lg:px-8">
            <span className="lg:hidden">
              <Brand />
            </span>
            <span className="hidden text-sm text-slate-500 lg:block">
              {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            </span>
            <div className="flex items-center gap-1">
              {meta.data && <Reminders />}
              <NavLink to="/settings" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden" aria-label="Settings">
                <Icon name="gear" />
              </NavLink>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 pt-5 pb-[calc(6rem+env(safe-area-inset-bottom))] lg:px-8 lg:pb-10">
          <ErrorBanner message={meta.error && `Couldn't load your wardrobe: ${meta.error}`} />
          {meta.data ? (
            <MetaContext.Provider value={meta.data}>
              <AiContext.Provider value={ai.data}>
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/wardrobe" element={<Wardrobe />} />
                  <Route path="/garments/:id" element={<GarmentDetail />} />
                  <Route path="/outfits" element={<Outfits />} />
                  <Route path="/pairs" element={<Pairs />} />
                  <Route path="/laundry" element={<Laundry />} />
                  <Route path="/laundry/:id" element={<BasketDetail />} />
                  <Route path="/plan" element={<Plan />} />
                  <Route path="/routines" element={<Routines />} />
                  <Route path="/calendar" element={<Calendar />} />
                  <Route path="/insights" element={<Insights />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<p className="text-slate-500">Page not found.</p>} />
                </Routes>
              </AiContext.Provider>
            </MetaContext.Provider>
          ) : (
            !meta.error && <Spinner />
          )}
        </main>
      </div>

      {/* Phone: bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" aria-label="Main">
        <div className="grid grid-cols-5">
          {TABS.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${isActive ? 'text-indigo-600' : 'text-slate-500'}`}
            >
              <Icon name={n.icon} className="h-6 w-6" />
              {n.label}
            </NavLink>
          ))}
          <button
            className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${moreOpen || inMore ? 'text-indigo-600' : 'text-slate-500'}`}
            onClick={() => setMoreOpen(!moreOpen)}
            aria-expanded={moreOpen}
          >
            <Icon name="grid" className="h-6 w-6" />
            More
          </button>
        </div>
      </nav>
      {moreOpen && (
        <div className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" onClick={() => setMoreOpen(false)}>
          <div
            className="absolute inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] grid grid-cols-3 gap-2 rounded-2xl bg-white p-3 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {MORE.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) => `flex flex-col items-center gap-1 rounded-xl p-3 text-xs font-medium ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700 active:bg-slate-100'}`}
              >
                <Icon name={n.icon} className="h-6 w-6" />
                {n.label}
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
