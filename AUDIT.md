# Divyajivan — Production-Readiness Audit

_Audited 2026-10-20 against the live codebase (`index.html`, `admin.html`, `sw.js`, Supabase backend, Netlify deploy). Findings below are verified by reading the actual code, not assumed._

---

## 1. Architecture map (what this app actually is)

| Layer | Reality |
|---|---|
| **Frontend** | One 497 KB file, `index.html` (~6,100 lines). React 18 UMD + **Babel-standalone** (JSX compiled in the browser on every load) + **Tailwind play-CDN**. Navigation is React state (`setScreen`), **no URL router, no real routes**. |
| **PWA** | `sw.js` (network-first cache), `manifest.json`, `offline.html`, version-check banner via `version.json`. |
| **"Auth"** | **Client-side only.** A hand-rolled `sb.auth` object stores accounts in `localStorage` (`dj_accounts`, `dj_session`) with **passwords in plaintext** (`u.pw !== password`). Google sign-in uses Firebase popup. **There is no server-side authentication.** |
| **Backend** | Supabase, anon key embedded in client. Data in `app_*` tables (`app_users`, `app_orders`, `app_appointments`, `app_insurance`, `app_family_members`, `app_vitals`, …). Rows keyed by **email**, not by an auth identity. |
| **Admin** | `admin.html` reads the same Supabase tables with the same anon key. |
| **Deploy** | `deploy.ps1` → **Netlify** (`netlify deploy --prod`). Folder is named `…-Vercel`, `.netlify/` present, and memory references GitHub Pages — **three deploy targets referenced, unclear which is canonical.** |
| **Unused** | `supabase-schema.sql` describes a *correct* `auth.users`-based design with proper RLS — but the app does **not** use it. |

---

## 2. Overall assessment

**Not production-ready for real patient data.** The app is a polished, working PWA, but its data layer has **no access control**: the single most important issue below means every user's medical information is readable and writable by anyone on the internet. Everything else is secondary to that.

For a demo / prototype with fake data, it is in good shape. For real users, the Critical items must be fixed first.

---

## 3. Findings by priority

### 🔴 CRITICAL

**C1 — Full patient-data exposure (broken access control).**
Every `app_*` table has RLS `FOR ALL USING (true) WITH CHECK (true)`. The anon key is public (it ships in the client JS, by design). Combined, this means **anyone with the app URL can read, modify, or delete every user's data** — vitals, blood group, DOB, insurance policy numbers, appointments, orders, home addresses — by calling the Supabase REST API directly. This is a severe privacy breach and would violate HIPAA/GDPR-class rules for health data.
_Impact:_ complete confidentiality and integrity loss of all user data.
_Fix requires:_ real Supabase Auth + RLS keyed to `auth.uid()` (the schema already drafted in `supabase-schema.sql`). **Needs your action in Supabase + an app auth rewrite — see Stage plan.**

**C2 — Fake authentication, plaintext passwords.**
Login is cosmetic: accounts and passwords live in `localStorage` in plaintext and are compared in the browser. No credential ever reaches a server. An account created on one device doesn't exist on another, and the "login" protects nothing at the data layer (see C1).
_Impact:_ no real user identity; passwords trivially readable; security entirely client-trusted.
_Fix requires:_ migrate login/signup/session to Supabase Auth (ties directly to C1).

### 🟠 HIGH

**H1 — No error boundary → blank white screen on any render error.**
A single thrown error in any screen unmounts the whole app to a blank page with no recovery. There are also ~33 silent `catch(e){}` blocks that swallow failures.
_Fix:_ add a React error boundary with a friendly fallback + "reload". **Safe, client-only, I can do now.**

**H2 — Service-worker caching serves stale app (the recurring "old version" bug).**
`sw.js` caches `index.html` and all GET responses. Navigations are network-first (good), but there's no cache versioning tied to `version.json`, so returning users can run old JS until the cache is manually cleared — exactly the stale-app issue seen repeatedly.
_Fix:_ version the cache, network-first for HTML with proper update→`skipWaiting`→reload handshake, don't cache cross-origin CDN/Supabase responses. **Safe, client-only, I can do now and verify.**

**H3 — Admin panel has no real authorization.**
`admin.html` uses the same public anon key and open RLS, so the admin dashboard's data is reachable by anyone (same root cause as C1). Any "admin" gate is client-side only.
_Fix:_ depends on C1/C2 (admin role via `profiles.is_admin` + RLS, as drafted in `supabase-admin.sql`).

### 🟡 MEDIUM

**M1 — Browser-compiled JSX + CDN Tailwind in production.**
Babel-standalone recompiles ~490 KB of JSX on every page load (large Time-to-Interactive cost, especially on phones), and Tailwind's play-CDN is explicitly not for production. 
_Fix:_ a lightweight build step (pre-compile JSX, generate a static Tailwind CSS file). Bigger change; recommend after Critical items.

**M2 — Deploy-target confusion.** Netlify vs Vercel vs GitHub Pages all referenced; `netlify.toml`'s publish path is a hard-coded local Windows path. Pick one canonical target and document it.

**M3 — No rate limiting on abuse-prone paths.** With open RLS, there's nothing stopping scripted mass reads/writes/inserts. Supabase has coarse built-in limits only. (Mostly resolved once C1 closes the tables; can add Supabase-side limits too.)

### 🟢 LOW / NOTES

- **L1 — SPA fallback:** state-based nav means direct-URL/refresh/deep-link and custom 404 are largely N/A; confirm the host serves `index.html` for all paths. A default screen fallback already exists (`default: HomeScreen`).
- **L2 — XSS surface is small:** React escapes by default; the one `dangerouslySetInnerHTML` renders hard-coded SVG constants, not user input. OK.
- **L3 — Secrets:** Supabase anon key and Firebase config are public by design (safe *only* with correct RLS — see C1). No private secret is leaked.

---

## 4. Not applicable to this architecture (stated honestly)

This is a static-hosted SPA with a managed Supabase backend and **no custom server**. These audit items from the brief therefore don't map to real work here:

- Custom **500 / 503** pages, server-side **429 / Retry-After** — no origin server to emit them (`offline.html` covers offline).
- Server-side **structured logging / APM / correlation IDs** — no backend process. Client error-tracking (e.g. Sentry) is possible but raises privacy questions for health data; recommend only after C1.
- **DB backups / PITR / migrations** — managed by Supabase; recommend enabling backups in the Supabase dashboard (I can't verify or change your plan).
- **CDN config** — handled by the static host; CDN libraries load from cdnjs/jsDelivr already.

---

## 5. Proposed staged fix plan

**Stage 0 — Safe client fixes (no backend, no approval needed, I verify in preview):**
- H1 error boundary + friendly fallback.
- H2 service-worker cache versioning & update handshake (kills the stale-app bug).
- Tighten the worst silent `catch(e){}` swallows around network calls (surface a toast/retry instead).

**Stage 1 — Close the data breach (C1/C2/H3) — needs you:**
This is the real fix and it's an architecture change:
1. Switch the app's login/signup/session from the localStorage shim to **Supabase Auth**.
2. Re-key `app_*` rows to `auth.uid()` and replace `USING(true)` with owner-only RLS (+ admin via `is_admin`).
3. Migrate existing rows to the new owner ids.
This touches auth, every sync call, and the admin panel, and requires running SQL in your Supabase project (a **destructive policy change**). I'll design it, show you the plan, and we do it together — **I won't run DB changes without your go-ahead.**

**Stage 2 — Performance/build (M1/M2):** optional build step to pre-compile JSX + static Tailwind; settle on one deploy target.

---

## 6. Status of fixes

| Item | State |
|---|---|
| Full audit | ✅ done (this document) |
| Stage 0 fixes | ⏳ awaiting your go-ahead |
| Stage 1 (auth/RLS) | ⛔ blocked — needs your approval + Supabase action |
| Stage 2 (build/deploy) | 💡 recommendation |

_Nothing has been changed in the code yet. No tests exist in the repo to run (single-file app, no test harness)._
