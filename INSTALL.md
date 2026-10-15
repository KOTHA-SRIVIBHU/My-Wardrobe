# Install ClosetIQ on your Android phone

Setup takes about 10 minutes and costs nothing. You'll create your own free cloud database. Your wardrobe is stored there, and only you can read it.

## 1. Install the app

1. Open the **ClosetIQ APK** link you were sent (or the latest file on the [Releases page](https://github.com/KOTHA-SRIVIBHU/My-Wardrobe/releases)) on your phone.
2. Tap the downloaded file. If Android asks, allow your browser or file manager to **install unknown apps**.
3. If Play Protect warns that the app is unrecognised, tap **More details → Install anyway**. It warns because the app isn't from the Play Store.

## 2. Create your free Supabase project (your vault)

1. Go to [supabase.com](https://supabase.com/dashboard) and sign up. Signing in with GitHub or Google is fine.
2. Click **New project**. Give it any name, generate a database password (you won't need it again), choose a region near you, and keep the **Free** plan.
3. Wait about a minute until the project is ready.

## 3. Connect the app

Open ClosetIQ and follow the setup screens:

1. **Project URL and key.** In Supabase, open **Project Settings → API** (or click **Connect**). Copy the **Project URL** and the **anon / publishable** key into the app.
   - Never use the `service_role` / secret key.
2. **Setup script.** The app shows a **Copy script** button and an **Open SQL editor** link. Paste the script into the SQL editor, press **Run**, and go back to the app. This is needed only once per project.
3. **Vault passphrase.** Choose a passphrase of at least 10 characters. Every device needs it to open your wardrobe.
   - **Write it down.** Nobody can recover it for you.
4. **AI (optional).** Paste a free Groq key from [console.groq.com/keys](https://console.groq.com/keys) to get photo → details, routine help and outfit notes. You can skip this and add it later in Settings.

That's it! Add your first clothes from the **Wardrobe** tab.

## Using it on another phone

Install the APK there too. Enter the **same** Supabase URL and key, skip the script step (it's already set up), and enter your passphrase. Both phones show the same wardrobe.

## Good to know

- **Change anything later:** in **Settings** you can update the Groq key and models, change the passphrase, switch to a different Supabase project, turn on app lock, and set notification times.
- **Notifications:** allow them when asked. You'll get a morning outfit briefing and an evening "get ready for tomorrow" reminder. Open the app now and then so they stay up to date.
- **Backups:** Settings → Backup & data → **Export backup** saves a file you can keep anywhere.
- **Supabase free plan:** projects pause after about a week with no activity. Using the app regularly keeps yours awake. If it pauses, open the Supabase dashboard and click **Restore project**. No data is lost.
- **Forgot the passphrase on every device?** In the Supabase SQL editor run `update closetiq_meta set passphrase_hash = null;`, then open the app, connect again and choose a new passphrase. Your clothes are kept.
- **Privacy:** the app's developer never sees your data. In the app, see **Settings → Privacy & data**.
