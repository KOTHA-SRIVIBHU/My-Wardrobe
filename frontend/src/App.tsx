import { createContext, useContext } from 'react'
import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { Icon, type IconName } from './components/Icon'
import { ErrorBanner, Spinner } from './components/ui'
import { api } from './lib/api'
import { supabase, useSession } from './lib/auth'
import { useLoad } from './lib/format'
import type { AiStatus, Meta } from './lib/types'
import BasketDetail from './pages/BasketDetail'
import { Reminders } from './components/Reminders'
import Calendar from './pages/Calendar'
import Insights from './pages/Insights'
import Plan from './pages/Plan'
import Routines from './pages/Routines'
import GarmentDetail from './pages/GarmentDetail'
import Home from './pages/Home'
import Laundry from './pages/Laundry'
import Login, { SetNewPassword } from './pages/Login'
import Privacy from './pages/Privacy'
import Outfits from './pages/Outfits'
import Pairs from './pages/Pairs'
import Wardrobe from './pages/Wardrobe'

const MetaContext = createContext<Meta | null>(null)
const AiContext = createContext<AiStatus | null>(null)

export function useMeta(): Meta {
  const meta = useContext(MetaContext)
  if (!meta) throw new Error('useMeta outside MetaContext')
  return meta
}

/** Null while loading or if the status call failed: treat as AI unavailable. */
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
    ],
  },
]
const NAV = NAV_GROUPS.flatMap((g) => g.items)

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

export default function App() {
  const { session, loading, recovering, doneRecovering } = useSession()
  const location = useLocation()
  if (location.pathname === '/privacy') return <Privacy />
  if (loading) return <Spinner />
  if (recovering) return <SetNewPassword onDone={doneRecovering} />
  if (supabase && !session) return <Login />
  return <Shell />
}

function Shell() {
  const meta = useLoad(() => api.meta(), [])
  const ai = useLoad(() => api.aiStatus(), [])

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Desktop: sidebar */}
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
        <div className="mx-3 mb-4 space-y-1">
          {supabase && (
            <button
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              onClick={() => supabase!.auth.signOut()}
            >
              <Icon name="logout" /> Sign out
            </button>
          )}
          <NavLink to="/privacy" className="block px-3 text-xs text-slate-400 hover:text-slate-600">Privacy &amp; data</NavLink>
        </div>
      </aside>

      <div className="lg:pl-60">
        {/* Top bar: brand + nav on mobile, reminders everywhere */}
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 lg:px-8">
            <span className="lg:hidden">
              <Brand />
            </span>
            <span className="hidden text-sm text-slate-500 lg:block">
              {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            </span>
            <div className="flex items-center gap-1">
              {meta.data && <Reminders />}
              {supabase && (
                <button className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden" onClick={() => supabase!.auth.signOut()} aria-label="Sign out">
                  <Icon name="logout" />
                </button>
              )}
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap ${isActive ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700'}`
                }
              >
                <Icon name={n.icon} className="h-4 w-4" />
                {n.label}
              </NavLink>
            ))}
          </nav>
        </header>
      <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8">
        <ErrorBanner message={meta.error && `Can't reach the ClosetIQ API: ${meta.error}`} />
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
                <Route path="*" element={<p className="text-slate-500">Page not found.</p>} />
              </Routes>
            </AiContext.Provider>
          </MetaContext.Provider>
        ) : (
          !meta.error && <Spinner />
        )}
      </main>
      </div>
    </div>
  )
}
