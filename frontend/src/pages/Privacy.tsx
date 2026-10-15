import { Link } from 'react-router-dom'

/** Plain-language disclosure of where data goes (reachable before setup). */
export default function Privacy() {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <article className="mx-auto max-w-2xl space-y-5 text-sm leading-relaxed text-slate-700">
        <Link to="/" className="text-indigo-700 hover:underline">← Back to ClosetIQ</Link>
        <h1 className="text-2xl font-bold text-slate-900">Privacy &amp; data</h1>
        <p>
          ClosetIQ has no server and no accounts. Everything you add is stored in <strong>your own Supabase project</strong>, which only
          you control. The developer of ClosetIQ never sees your data.
        </p>

        <section>
          <h2 className="mb-1 text-base font-semibold text-slate-900">What's stored, and where</h2>
          <p>
            Your garments and their photos, pairs, laundry baskets, routines, calendar events, plans, settings and usage history are
            stored in the Supabase database you connected. Every request must carry your <strong>vault passphrase</strong>; the
            database checks it (against a bcrypt hash) before returning anything, so your Supabase key alone can't read your data.
          </p>
          <p className="mt-1">
            On your phone, the Supabase URL and key, the passphrase and your Groq key are kept in Android's encrypted storage
            (Keystore). They never leave the device except to talk to Supabase and Groq directly.
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
              dates. Garment names and notes are never sent.
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
            <li><strong>Export</strong> everything, photos included, from Settings → Backup &amp; data.</li>
            <li><strong>Delete everything</strong> there too, or delete the whole Supabase project from your Supabase dashboard.</li>
            <li><strong>Disconnect</strong> a phone at any time; the data stays in your cloud for your other devices.</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-1 text-base font-semibold text-slate-900">No tracking</h2>
          <p>There are no ads, no analytics and no tracking. Notifications are scheduled on your phone; nothing is pushed from a server.</p>
        </section>
      </article>
    </div>
  )
}
