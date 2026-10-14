import { Link } from 'react-router-dom'

/** Plain-language disclosure of where data goes (public page, no sign-in needed). */
export default function Privacy() {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <article className="mx-auto max-w-2xl space-y-5 text-sm leading-relaxed text-slate-700">
        <Link to="/" className="text-indigo-700 hover:underline">← Back to ClosetIQ</Link>
        <h1 className="text-2xl font-bold text-slate-900">Privacy &amp; data</h1>
        <p>ClosetIQ is a personal project. This page explains what it stores, where, and what's shared with other services.</p>

        <section>
          <h2 className="mb-1 text-base font-semibold text-slate-900">What's stored</h2>
          <p>
            Your email address and password (handled by Supabase Auth); your garments and their photos; pairs, laundry baskets,
            routines, calendar events, plans, settings and usage history. Each account can only ever see its own data.
          </p>
        </section>

        <section>
          <h2 className="mb-1 text-base font-semibold text-slate-900">Where it's stored</h2>
          <p>
            Data and photos are stored with <strong>Supabase</strong> (database, file storage and login). Photos are kept in a
            private bucket and shown through short-lived links. The app itself runs on <strong>Render</strong> (server) and{' '}
            <strong>Vercel</strong> (website).
          </p>
        </section>

        <section>
          <h2 className="mb-1 text-base font-semibold text-slate-900">What's shared with AI (Groq)</h2>
          <p>AI features are optional and only run when you press their buttons:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Suggest details</strong> sends that one photo to Groq to describe the garment.</li>
            <li><strong>Turn into routines</strong> sends the text you typed.</li>
            <li>
              <strong>Why this works</strong> and <strong>Weekly brief</strong> send only colours, categories, formality, weather and
              dates. Garment names, notes and your email are never sent.
            </li>
          </ul>
          <p className="mt-1">AI suggestions are never saved until you confirm them.</p>
        </section>

        <section>
          <h2 className="mb-1 text-base font-semibold text-slate-900">Weather</h2>
          <p>
            If you set a city, its coordinates are sent to <strong>Open-Meteo</strong> to fetch the forecast. Nothing else about you
            is sent.
          </p>
        </section>

        <section>
          <h2 className="mb-1 text-base font-semibold text-slate-900">Your controls</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Export</strong> everything, photos included, from Insights → Account.</li>
            <li><strong>Delete your account</strong> there too: it removes all your data, photos and your login permanently.</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-1 text-base font-semibold text-slate-900">Fair use</h2>
          <p>
            The app runs on free service tiers, so each account has a daily limit on AI requests and a limit on how many garments it
            can store. There are no ads and no tracking.
          </p>
        </section>
      </article>
    </div>
  )
}
