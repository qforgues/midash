# miDash — Project State & Handoff

> Read this first to resume work. It's the single source of truth for where the
> project stands, how it's wired, and what's next. Keep it updated as we go.

**Current version:** `1.21.0` (see `CONFIG.version` in `index.html`)
**Owner:** Q — quentin.forgues@gmail.com
**Last updated:** 2026-06-30

---

## Strategic direction (decided 2026-06-28 — read before proposing big changes)

The goal is **"a personal dashboard that opens like an app,"** not a production SaaS.
Optimize the *current* architecture; do **not** build a "v2 backend" unless a real pain
forces it. The serverless setup (static page + Worker, no DB, no server, no hosting bill)
is a core strength — protect it.

- **Login once each morning is acceptable.** The hourly Google re-login is a non-problem.
  The client-side token flow gives no refresh token by design; fixing that means a backend
  (auth-code flow, refresh tokens, encrypted storage, sessions) — not worth it for one user.
  Do **not** build refresh-token auth unless the re-login becomes genuinely annoying.
- **Real risk to fix = the open `/chat` and `/notes` Worker endpoints.** Anyone who finds
  the URL could spam Anthropic → surprise bill. Lock them with a simple shared passphrase
  stored locally — not passkeys, not OAuth, not accounts.
- **Vision:** miDash as the "operating system for Quentin" — every service as just another
  *card* (Google, Discord, Portal42, La Palma, weather, solar, cameras, recipes, Spanish,
  daily briefing…). New cards don't touch the login architecture. Keep it simple/fast/cheap.

**Roadmap (in order):**
1. ✅ **PWA / installable** (v1.9.0) — home-screen icon, standalone, offline shell.
2. ✅ **Lock `/chat` + `/notes`** behind a shared passphrase (v1.10.0) — Worker
   `authed()` gate vs. the `DASH_KEY` secret; fails open until the secret is set.
   Set it with `wrangler secret put DASH_KEY`; enter the same value on each device
   (⚙️ → 🔒 Dashboard passphrase, or when prompted after a 401).
3. Polish UI + mobile.
4. More cards / integrations.
5. *Only if re-login becomes annoying:* backend for refresh tokens.

---

## What this is

A personal single-page command-center dashboard ("miDash") — calendar, mail,
projects, work, kids, fun/play, plus a Notes scratchpad and an embedded AI chat
agent. Static site, no build step, hosted free on GitHub Pages. A Cloudflare Worker
is the "brain" (holds the Anthropic key + Notes storage). The Raspberry Pi is meant
to be an external retriever that talks to the same Worker via a messaging app
(Discord) — not built yet (see Backlog).

## Live locations

- **Site:** https://qforgues.github.io  (repo: `qforgues/midash`, branch `main`, root)
- **Worker (brain):** https://midash-chat.quentin-forgues.workers.dev
- **Worker chat endpoint:** `POST /`  (Anthropic messages + tools)
- **Notes endpoint:** `GET/PUT /notes`  (Cloudflare KV, currently open/no-auth)
- **Finance proxy:** `POST /finance`  (42payments/FreshBooks; key held server-side)
- **CC payoff plan:** `GET/PUT /ccplan`  (KV `ccplan` blob — debt card)
- **Projects board:** `GET/PUT /projects`  (KV `projects` array — projects tracker, v1.20.0)
- All non-chat endpoints are gated by the `DASH_KEY` passphrase via `authed()`.

## Accounts & keys

- **Google OAuth client ID (public, safe to commit):**
  `649111264239-gro8ns552nso1398knfv03hc63rb5o8d.apps.googleusercontent.com`
- **Connected Google accounts:** `quentin.forgues@gmail.com` (alias "Mine"),
  `quentin@portal42.us` (alias "Portal42")
- **Anthropic key:** lives ONLY as a Wrangler secret on the Worker
  (`wrangler secret put ANTHROPIC_API_KEY`). Never in the repo.
- **Dashboard passphrase:** `DASH_KEY` Wrangler secret gates `/chat` + `/notes`
  (`wrangler secret put DASH_KEY`). The dashboard sends it as `Authorization:
  Bearer <key>`, stored only on-device (localStorage `midash_dash_key`). Worker
  **fails open** if unset. `wrangler secret delete DASH_KEY` to disable.
- **KV namespace:** `NOTES`, id `f095586747ee4a47b524082986e8f725` (in `wrangler.jsonc`)
- **Model:** switchable from the chat header (picker). Default `claude-haiku-4-5`
  (cheapest); options `claude-sonnet-4-6`, `claude-opus-4-8`. The dashboard sends
  `model` in the chat POST body; the Worker validates it against `ALLOWED_MODELS`
  and falls back to `DEFAULT_MODEL`. **This is the metered Anthropic API — billed
  per token, separate from any Max plan. Cap spend in the Anthropic Console.**
- **OAuth scopes:** `openid email`, `calendar.events`, `gmail.modify`, `gmail.send`,
  `contacts.readonly` (People API → Contacts dropdown + daily reach-out),
  **`tasks`** (full read+write — upgraded from `tasks.readonly` in v1.13.0 for the
  idea→task flow; **requires a one-time reconnect** to grant write). The **People API +
  Tasks API must be enabled** in the Google Cloud project behind the OAuth client.

---

## Files

| File            | Purpose |
|-----------------|---------|
| `index.html`    | The whole dashboard — UI, CSS, JS, CONFIG. **Edit `CONFIG` at the bottom of `<script>`.** |
| `worker.js`     | Cloudflare Worker: chat agent (Anthropic) + `/notes` KV storage. The "brain." |
| `wrangler.jsonc`| Worker config incl. KV binding. |
| `manifest.webmanifest` | PWA manifest (name, icons, standalone). Relative paths so it works under `/midash/`. |
| `sw.js`         | Service worker: network-first HTML (no stale-version lock), cache-first icons, cross-origin passthrough. |
| `icon-192.png` `icon-512.png` `apple-touch-icon.png` | App icons. Regenerate with `node scripts/genicon.js .` (dependency-free Node PNG encoder). |
| `scripts/genicon.js` | Generates the app-icon PNGs (brand-green 2×2 dashboard-tile mark). |
| `server.js`     | Raspberry Pi / Node backend (Discord). **Stale** — not updated with the new tools/notes. |
| `llms.txt`      | Tells AI crawlers what the site is. |
| `README.md`     | Setup docs (Google OAuth, Worker deploy, KV, notes). |
| `setup.sh`      | One-shot git + GitHub Pages bootstrap (already run). |
| `PROJECT.md`    | This file. |

## Architecture (how it fits together)

- Browser loads `index.html`. Google sign-in happens **client-side** (Google Identity
  Services token flow) — calendar/mail data and all Gmail/Calendar actions run in the
  browser with the user's own OAuth token. The Worker never sees Google credentials.
- The chat agent: browser sends the conversation to the Worker → Worker calls Anthropic
  with the TOOLS schema → returns tool calls → **tools execute in the browser** using the
  Google token → results loop back. So the Anthropic key stays on the Worker, Google
  creds stay in the browser.
- Notes: textarea autosaves to the Worker's KV (`PUT /notes`); loads from `GET /notes`;
  localStorage is the offline cache. The agent's `read_notes` tool reads the synced copy.

## Agent tools (defined in `worker.js`, executed in `index.html`)

`search_emails`, `get_email`, `reply_email`, `trash_email`, `archive_email`,
`mark_read`, `list_events`, `create_event`, `delete_event`, `send_email`,
`list_tasks`, `create_task`, `complete_task`, `read_notes`,
`list_projects`, `update_project`, `add_project`,
`finance_*` (summary/list/profit_loss/create_invoice/log_expense/add_client/mark_invoice_paid).

**Idea → reality flow (v1.13.0):** ideas incubate in **Notes** (capture box "💡 Save this
idea" + `read_notes`); **Tasks** are the actionable layer (Google Tasks, now read+write).
Capture box "⏰ Remind me to…" creates a **real Google Task** (Notes-line fallback if write
isn't granted); the Tasks card has a **＋ quick-add** and **tap-to-complete** checkbox; the
agent bridges them (`read_notes` → `create_task`; `list_tasks` → `complete_task`), so
"turn my notes into tasks" / "mark X done" work in chat. `create_task`/`complete_task` act
without a confirm (low-stakes); `defaultAcct()` + `@default` list = primary account's
default Tasks list.
All are **multi-account aware** (sweep every connected account, tag results with
`account`). Reply/trash/delete/**create_event**/**send_email** pop an on-screen `confirm()`
first. `create_event` defaults to the **primary** calendar; `send_email` sends a NEW message
(use `reply_email` for replies).

**Inbox row actions + unsubscribe (v1.14.0):** each Unread-inbox row has 📥 Archive and
🚫 Unsub buttons (`archiveMailRow`/`unsubMailRow` → Gmail `modify` removeLabelIds
INBOX+UNREAD). Unsub also queues the sender locally (`midash_unsub`). The Show: bar's
**🚫 Unsubscribe (N)** pill opens the queue; "Find best unsubscribe" live-searches
`from:<sender>`, aggregates **List-Unsubscribe** headers, and offers the best option — open
the unsub page (https) or **send the unsubscribe email** via gmail.send (mailto, parsed).

**Menu split (v1.14.0):** header has **⚙️ gear** (Appearance/profile + passphrase + install)
and a **☰ hamburger** (all the links — `#gear-sections` moved into `#links-menu`).
`initGearMenu` toggles them mutually-exclusively.

**Gotcha fixed:** `generateDraft` (Stay-connected) called the Worker without
`dashAuthHeader()` and parsed `res.json()` even though the Worker streams — it now routes
through `streamModel(null, msgs)`. **Any new Worker call must use `streamModel` or include
`...dashAuthHeader()`** (the Worker is passphrase-gated and streams SSE).

**Chat is streamed** (v1.11.0): the Worker proxies Anthropic's SSE; the browser
(`streamModel` in `index.html`) reconstructs the message (text/thinking/tool_use blocks +
`usage`) while rendering the answer token-by-token. **Adaptive thinking** + `effort:"medium"`
are enabled **only on `sonnet-4-6`/`opus-4-8`** (Haiku 4.5 400s on those params — gated by
`SMART_MODELS` in `worker.js`). A **daily usage meter** in the chat header estimates metered
spend from each response's `usage`, accumulated per local day, resetting at midnight
(`midash_usage` in localStorage; pricing table `PRICE` in `index.html`).

> **Cost note:** every chat turn resends the full `system` + `TOOLS` schema (~2.3k input
> tokens/turn, uncached). Adding prompt caching (`cache_control` on the system block in
> `worker.js`) would cut that ~90% — a good future optimization, not yet done.

---

## Projects tracker (v1.20.0)

A main-column **🚀 Projects** card — an idea→shipped progress board so every
software/website/app project keeps moving and none gets left behind. Lives entirely
in `index.html` (search `PROJECTS — idea→shipped`), backed by the Worker's
`GET/PUT /projects` KV blob (mirrors `/ccplan`) with a localStorage cache.

- **Pipeline:** `PIPELINE` const — 💡 Idea → 🔬 Validate → 📝 Plan → 🛠️ Build →
  🧪 Test → 🚀 Ship → 📈 Grow. Progress % is the stage index over the last stage.
- **One record = all values:** `{id,name,url,repo,stage,next,notes,updated,pinned,order}`.
  `normalizeProject()` coerces/clamps; `next` is the single "push it forward" action.
- **Neglect surfacing:** `projStale()` flags un-shipped projects amber >14d / red >30d
  (touched = `updated`); the header + summary show "N need a push". Stages ≥ Ship are
  "live" and never nagged.
- **Sources:** ＋ Add (manual) and ⇪ Import GitHub repos (pulls `githubUser`'s repos as
  Idea-stage, de-duped by repo/name — imported repos inherit `pushed_at` so old ones show
  red on purpose). Sort: most-neglected / stage / A–Z / manual.
- **Agent:** `list_projects` / `update_project` / `add_project` (worker.js TOOLS +
  `executeTool` in index.html). They run in the browser like the other tools, need no
  Google (`noGoogle` exemption: `/projects?$/`), and act without a confirm. So
  "what's most neglected?", "move La Palma to ship", "track a new idea: …" work in chat.
- First-run seed: miDash + the `pinnedProjects` entries.

## Version-driven look + menu lock (v1.21.0)

- **Look refresh on upgrade** (`applyVersionTheme()` in index.html, runs at boot before
  `applyBackground()`). Q's versioning, NOT strict semver: the **middle** segment
  (`1.21→1.22`) is the "major" bump → fresh background **design** + colors; the **last**
  segment (`1.22.0→1.22.1`) is the "minor" bump → fresh **colors**, same design; the first
  segment (if it ever moves) is a design bump too; no increase changes nothing.
  Tracked via `midash_theme_ver` (separate from the version-highlight's
  `midash_ver_*`). First run only showcases it if appearance is still default — manual
  themes are respected until the next bump; **Settings → Reset appearance** clears it and
  the next bump re-rolls. Colors come from `randomThemeColors()` (HSL→hex), pattern from
  `randomPattern()`. **So: bump the LAST segment for a color refresh, the MIDDLE segment for a new design.**
- **Hamburger (☰) gated by the passphrase:** `refreshMenuLock()` shows 🔒 and routes a
  click to the passphrase modal when no `DASH_KEY` is held on the device; the ⚙️ gear menu
  stays open (that's where you set the key). Re-evaluated on save/clear in the key modal.

## Daily workflow

**Dashboard change** (`index.html`, links, CSS, JS):
```bash
# 1. edit index.html (CONFIG is at the bottom of the <script>)
# 2. BUMP CONFIG.version so you can tell the new build apart on the live site
# 3. push
cd ~/miDash && git add -A && git commit -m "vX.Y.Z: ..." && git push
# 4. hard-refresh the site: Cmd+Shift+R  (GitHub Pages CDN + Safari cache are sticky)
```

**Worker change** (`worker.js`, tools, system prompt, notes):
```bash
cd ~/miDash && wrangler deploy
```

**Conventions**
- `CONFIG.version` is baked into the page and shown by the greeting; the digit(s) that
  changed since you last loaded are highlighted in the accent color. **Always bump it.**
- Google links pin to `CONFIG.account`. Use the **literal email** in Gmail `/u/<email>/`
  URLs — URL-encoding the `@` (`%40`) causes a Gmail 404.
- Account identity is editable: alias (✎ on the chip) + color (swatch on the chip).
  The **primary account's** color (or the menu's theme swatch) drives the global accent;
  per-item pills/dots/row-hovers use each item's own account color.

---

## Known gotchas (don't re-discover these)

- **CSS grid blowout:** long unbreakable URLs in event titles force columns wide unless
  grid/flex items have `min-width:0`. Already applied to `.main`, `.split > *`, agenda/mail
  rows. Keep `overflow-wrap:anywhere` on title/URL text.
- **Gmail 429 "Too Many Requests" / "temporarily unavailable":** two accounts × many
  parallel `messages.get` calls trips rate limits. Volume was reduced (15 unread + 20 promo
  per account). If it recurs, lower further or add throttling.
- **Gmail deep links:** `/u/<email>/` is flaky; prefer the literal email, and for
  unsubscribe we now read the email's `List-Unsubscribe` header and open that URL directly
  (no Gmail bounce).
- **Notes are currently open (no auth)** for simplicity. To lock later: set a `NOTES_KEY`
  Worker secret and have the dashboard send `Authorization: Bearer <key>` (the UI scaffolding
  for a sync-key prompt was removed but easy to restore).
- **`color-mix()`** is used for tints — fine on modern Chrome/Safari (Q's setup).
- **Caching:** after a push, GitHub Pages can serve the old file for ~10 min; always
  hard-refresh and confirm `CONFIG.version` before assuming a change didn't work.

## First-time / re-setup checklist

1. Google Cloud: OAuth consent screen has Q's Gmail as a Test User; client ID authorizes
   `https://qforgues.github.io` (and `http://localhost:8000`) as JS origins.
2. After any scope change, click **Connect Google** again (✕ the chip, reconnect) for fresh consent.
3. Worker: `wrangler deploy`; secret `ANTHROPIC_API_KEY` set; KV `NOTES` bound.
4. Add the 2nd account with **＋ account** on the dashboard.

---

## Backlog / next up

- [ ] **Raspberry Pi / "claw42" (OpenClaw) cleanup** — the big one. Make the Pi a clean
      Discord retriever that calls the **same Worker brain**. Tidy the project to match the
      dashboard's quality.
- [ ] **Update `server.js`** (Pi backend) to match `worker.js`: add `/notes`, `delete_event`,
      `read_notes`, multi-account tool behavior, updated SYSTEM prompt.
- [ ] **Lock Notes** with `NOTES_KEY` when ready (restore the 🔑 sync-key UI).
- [ ] Optional: scheduled briefings (daily agenda/inbox digest), school-portal link for Kids.
- [x] Richer Projects — idea→shipped tracker card (v1.20.0).

## Quick "where were we" log

- v1.6.x: top menu collapsed to a one-row hover-dropdown bar; agenda 60 / notes 40;
  full-width content; per-account row/badge colors; theme color picker; one-click
  unsubscribe via `List-Unsubscribe`; Gmail 404 + 429 fixes; Notes synced via Worker KV.
- v1.16–1.19: 42payments finance card + tools; Credit-Card Debt card + payoff plan;
  La Palma TV pinned atop the Projects quick-links.
- v1.20.0: **Projects tracker** card (idea→shipped board, `/projects` KV, agent tools).
- v1.21.0: **version-driven look** (major→design, minor→colors) + **hamburger gated**
  behind the dashboard passphrase.
- Next session likely starts on the **Pi/claw42** cleanup.
