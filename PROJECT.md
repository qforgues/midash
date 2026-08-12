# miDash — Project State & Handoff

> Read this first to resume work. It's the single source of truth for where the
> project stands, how it's wired, and what's next. Keep it updated as we go.

**Current version:** `1.46.2` (see `CONFIG.version` in `index.html`)
**Owner:** Q — quentin.forgues@gmail.com
**Last updated:** 2026-08-11 (flow layer — waiting-on / blocked-by; then three capture fixes from real use)

> **Versioning scheme (Q's, NOT semver):** middle segment = "major" bump → rolls a fresh
> background **design** + colors; last segment = "minor" bump → rolls fresh **colors** only.
> Always bump `CONFIG.version` on any dashboard change (see `applyVersionTheme()`).

---

## Strategic direction (decided 2026-06-28 — read before proposing big changes)

The goal is **"a personal dashboard that opens like an app,"** not a production SaaS.
Optimize the *current* architecture; do **not** build a "v2 backend" unless a real pain
forces it. The serverless setup (static page + Worker, no DB, no server, no hosting bill)
is a core strength — protect it.

- **Google stays signed in via silent GIS renewal (v1.25.4).** The hourly re-login WAS annoying,
  so we added `refreshGoogleTokens()` — before the 1h token expires it silently re-requests a
  fresh one (`tokenClient.requestAccessToken({prompt:"", hint:email})`), no popup, **no backend**.
  Runs on a 5-min timer + on tab focus. Falls back to manual "Connect Google" only if the
  browser's Google session actually dies. Do **not** build a backend refresh-token flow — this
  client-side silent renew is the intended fix.
- **Worker access is locked (v1.31.0).** `authed()` gates every route once `DASH_KEY` is set;
  constant-time compare. Fail-open is now **narrow** — with no key set only `GET /notes` and
  `GET /discord-status` are open; `/chat`, `/agent`, the finance WRITE proxy, `/tracker`, and all
  PUTs return `401 {code:"setup"}`. `/chat` + `/agent` are rate-limited (30 / 5 min per isolate).
  **A hard spend cap is set in the Anthropic Console (done 2026-07-02)** — the real cost ceiling.
- **Vision:** miDash as the "operating system for Quentin" — every service as just another
  *card* (Google, Discord, Portal42, La Palma, weather, solar, cameras, recipes, Spanish,
  daily briefing…). New cards don't touch the login architecture. Keep it simple/fast/cheap.
- **Spine — own the brain, the state, and the orchestration (decided 2026-07-10).** When we need a
  behavior, we *build it ourselves* rather than outsource the logic to a black box we can't tune.
  Third parties are **dumb pipes** (Discord = transport, Twilio = SMS wire) and **dumb data sources**
  (Google = mail/calendar/tasks data, FreshBooks = finance data) — never the decision-maker or the
  owner of our state. This is already the shape of the app (Worker = brain + KV state; Google/Discord
  as edges) and it's the default for new features. The reminders system (v1.41.0) is the canonical
  example: we own the queue (KV) and the scheduler (cron), and Discord is just the pipe that carries
  the DM — chosen *over* Google Calendar's native reminders precisely because those are a black box.

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
is the "brain" (holds the Anthropic key + Notes storage). The Raspberry Pi (`claudeclaw`)
is now an external retriever: the **Dash** Discord bot on the Pi relays DMs to the Worker's
`/agent` endpoint (built 2026-07-02 — the old "claw42" backlog item, done). 42payments also
moved to the Pi so both stay up when the Mac is closed.

## Live locations

- **Site:** https://qforgues.github.io  (repo: `qforgues/midash`, branch `main`, root)
- **Worker (brain):** https://midash-chat.quentin-forgues.workers.dev
- **Worker chat endpoint:** `POST /`  (Anthropic messages + tools; rate-limited)
- **Notes endpoint:** `GET/PUT /notes`  (Cloudflare KV; PUT is **merge/clobber-guarded** via an
  `X-Notes-Based-On` hash → `409` on concurrent change, v1.32.0)
- **Finance proxy:** `POST /finance`  (42payments/FreshBooks; key held server-side)
- **CC payoff plan:** `GET/PUT /ccplan`  (KV `ccplan` blob — now holds `{strategy,target,monthly,cards[]}`)
- **Projects board:** `GET/PUT /projects`  (KV `projects` array; **PUT merges server-side**,
  tombstone-aware, and returns the merged set — v1.31.0)
- **Contacts meta:** `GET/PUT /contacts-meta`  (KV `contacts_meta` — tags/hidden/usage for Stay-connected)
- **Tracker42 proxy:** `GET/POST /tracker?action=…`  (Portal42 tickets; `PORTAL42_TOKEN` server-side)
- **Discord agent brain:** `POST /agent`  (server-side tool loop for Discord/SMS — no browser; rate-limited)
- **Discord heartbeat:** `GET/POST /discord-status`  (bot posts liveness; switchboard reads it)
- **Reminders:** `GET/POST/DELETE /reminders`  (KV `reminders` blob; miDash-owned push. POST adds
  `{at,text,kind}`, GET lists pending, DELETE `?id=`. A **1-minute Cron Trigger** (`scheduled()` →
  `fireDueReminders`) DMs due ones to Q on Discord via the REST API — needs secrets
  `DISCORD_BOT_TOKEN` + `DISCORD_USER_ID`. The Worker sends the DM itself, so it doesn't depend on
  the Pi. Only writes KV on add/delete/fire → safe under the ~1000/day write budget. v1.41.0)
- **Flow (waiting/blocked):** `GET/PUT /flow`  (KV `flow` blob — the two states Google Tasks can't
  hold. Entries keyed by Google task id, or `pending:<title>` when written from Discord, which has
  no task ids; the browser re-keys those on its next load. **PUT merges per-entry LWW** and returns
  the merged set, like `/projects`, so the browser never merges. v1.45.0)
- **Watches (conditionals):** `GET/POST/DELETE /watch`  (KV `watches` blob. POST adds
  `{at,who,thenTitle,thenNotes,since,reminderId}`; `POST {resolve:id,result}` settles one; GET lists
  pending. The Worker queues them and fires the Discord ping on time via the normal reminder path,
  but **cannot evaluate one** — the condition is a Gmail question and Google creds live only in the
  browser, so `runDueWatches()` settles them when the dashboard is open. v1.46.0)
- **Discord push health:** `GET /discord-check`  (validates `DISCORD_BOT_TOKEN` via `/users/@me` +
  `DISCORD_USER_ID` by opening a DM channel — no message sent; `?send=1` delivers a real test DM.
  The Switchboard **Discord card** shows inbound heartbeat + outbound push in one, with a "🔔 Send
  test DM" action. v1.41.0)
- **Tool inspection:** `GET /tools`  (canonical tool names + chat schemas; v1.36.0)
- Every route is gated by `DASH_KEY` via `authed()` (constant-time; narrow fail-open — see
  Strategic direction). The whole fetch handler is wrapped in try/catch so a crash returns a
  CORS-safe JSON error (never Cloudflare's bare error page, which the browser misreports as CORS).

## Current system map (2026-07-02, v1.37.0)

The "operating system for Quentin" vision is now largely realized. What runs where:

| Piece | Repo | Host | Notes |
|---|---|---|---|
| Dashboard (static SPA) | `qforgues/midash` | GitHub Pages | `index.html` (all UI/CSS/JS/CONFIG) |
| Brain (Anthropic + proxies + KV) | `qforgues/midash` | Cloudflare Worker | `worker.js`; secrets: `ANTHROPIC_API_KEY`, `DASH_KEY`, `PAYMENTS_API_KEY`, `PORTAL42_TOKEN` |
| Discord agent "miDash"/Dash | `qforgues/midash-discord` (private) | **Pi** `midash-discord.service` | DMs → Worker `/agent`; auto-locks to first DMer; heartbeats `/discord-status` |
| 42payments (FreshBooks app) | `qforgues/42payments` (private) | **Pi** `midash-42payments.service` | moved off the Mac 2026-07-02; served via the Pi's cloudflared tunnel |
| Cloudflare tunnel | — | **Pi** `cloudflared.service` | `/etc/cloudflared/config.yml`; serves `42payments.myeasyapp.com` + `claw42.myeasyapp.com` |

**Pi** = `claudeclaw` (Raspberry Pi 4). Reach it: **`ssh claudeclaw`** (mDNS `claudeclaw.local`, IP-independent;
DHCP IP was `.211`). It also runs a *separate* Python bot (`pi-bot.service` = claw42) — unrelated to Dash.
The Mac's old 42payments + tunnel LaunchAgents are disabled (`*.plist.disabled`).

**Cards on the dashboard (top→bottom):** 🎛️ Switchboard (connection lights; the **Google** light now
hosts the account pills, one per row) · Command bar (⏰ Remind → Google Task w/ parsed due date, ✉️ Draft,
💡 Idea) · Unread inbox (🚫 unsubscribe icon next to refresh — the old "Show:" filter row was removed
v1.27.3) + Next 3 events · **Portal42 Tickets ‖ Tasks** (50/50 split) · 🚀 Projects · **Stay-connected ‖
Notes** (50/50 split). **Every card header has a collapse chevron** (state persists). *(Credit Card Debt
moved OUT of the flow → ☰ Tools menu modal, v1.27.3.)*

**☰ Tools menu:** 🗓️ **Weekly review** (rollup modal, "• due" after 7d) · 💳 **Credit Card Debt**
(balances + card editor + deterministic payoff schedule + agent handoff).

**Header:** date reads "Wednesday, 2 July"; clock shows 12h with 24h in small parens, e.g. `2:34 PM (14:34)`.
"miDash" is large, the version small.

*(Finance summary card removed v1.25.0; 42payments still powers Debt + the switchboard + agent finance tools.)*

**Discord = another front door to the same brain.** DM the bot → `/agent` runs a server-side tool loop
(no browser) with **notes, projects, Tracker42 tickets, and 42payments finance** tools. Gmail/Calendar/
Tasks are NOT available over Discord (they need the in-browser Google token).

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
  (cheapest); options `claude-sonnet-4-6`, `claude-opus-4-8`, **`claude-fable-5`** (newest,
  added v1.27.4). Worker validates `model` against `ALLOWED_MODELS`, falls back to `DEFAULT_MODEL`;
  `SMART_MODELS` (sonnet/opus/fable) get thinking + effort + tools. **Metered Anthropic API —
  hard spend cap set in the Anthropic Console (2026-07-02).**
- **OAuth scopes:** `openid email`, `calendar.events`, `gmail.modify`, `gmail.send`,
  `contacts.readonly` (People → Contacts + reach-out), **`tasks`** (full read+write). The **People
  API + Tasks API must be enabled** in the Google Cloud project.
  ⚠️ **`contacts.other.readonly` was DROPPED (v1.27.0):** it's a *sensitive* scope Google gates
  behind app verification, so requesting it on the unverified app failed the whole consent with
  Google's generic "Something went wrong." `loadContacts()` tolerates the auto-collected
  "otherContacts" pool being absent (My Contacts still load). Re-add only after the app is verified.

---

## Files

| File            | Purpose |
|-----------------|---------|
| `index.html`    | The whole dashboard — UI, CSS, JS, CONFIG. **Edit `CONFIG` at the bottom of `<script>`.** |
| `worker.js`     | Cloudflare Worker: chat agent (Anthropic) + `/notes` KV storage. The "brain." |
| `wrangler.jsonc`| Worker config incl. KV binding. |
| `manifest.webmanifest` | PWA manifest (name, icons, standalone). Relative paths so it works under `/midash/`. |
| `sw.js`         | Service worker: network-first HTML (no stale-version lock), cache-first icons, cross-origin passthrough. |
| `tests.html`    | **Zero-build regression tests** (open in a browser; NOT linked from the UI). Copies of the pure functions (`mergeProjects`, `normalizeProject`, `stamp`, `verNewer`, `esc/escAttr`, `safeUrl`, `notesHash`, `repairChat`, `pushUserMessage`, `computePayoff`, `parseReminder`, `resolveAt`, `taskBuckets`/`blockerOpen`, `mergeFlow`/`pruneFlow`,
`defaultReminderAt`, `splitDetail`/`isNotifyOnly`/`captureNotes`) with a **KEEP IN SYNC** note — 158 assertions. ⚠️ The copies must be updated in lockstep with the originals (a review once flagged drift). |
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
`mark_read`, `list_events`, `create_event` (takes optional **`projectId`** to tag property
work so it shows on the project card), `delete_event`, `send_email`,
`list_tasks`, `create_task`, `complete_task`, `update_task` (reschedule/rename — change a task's
due date via list_tasks → update_task), `read_notes`, `add_note` (Discord path),
`list_projects`, `update_project`, `add_project` (all **type-aware**: software|property, with
property/area/people), `set_reminder`/`list_reminders`/`cancel_reminder` (miDash-owned Discord-DM
push — a reminder is a NOTIFICATION, distinct from a Google Task to-do; see `/reminders`),
`set_waiting`/`clear_waiting`/`block_task`/`list_waiting` (the flow layer — KV-backed, so these
are the FIRST task-shaped tools that also work over Discord),
`finance_*` (summary/list/profit_loss/create_invoice/log_expense/add_client/mark_invoice_paid).

> **Tool schemas are single-sourced (v1.36.0):** the project tools live in one `PROJECT_TOOLS`
> const in `worker.js`; the reminder tools in one `REMINDER_TOOLS` const — both spread into `TOOLS`
> (chat) and `AGENT_TOOLS` (Discord) so they can't drift. `GET /tools` returns the canonical list.
> Reminder tools execute in the browser (`executeTool` → `POST /reminders`, tz-aware via `resolveAt`)
> AND in the Worker (`runAgentTool`, for the Discord agent, via `resolveAtServer` — relative/ISO-offset
> times only, since the Worker has no browser tz).

> **Robustness (v1.31.0–1.33.1):** tool errors carry `is_error:true`; a tool whose input JSON was
> truncated mid-stream is NOT executed on `{}` (returns a retry error); `repairChat()` on load
> injects a synthetic error `tool_result` for any dangling `tool_use` (interrupted loop) so the chat
> can't brick; `pushUserMessage()` never creates two consecutive user turns. Google `gfetch`/`gpost`
> silently refresh the token and retry once on a 401 (`refreshTokenFor`, deduped per email).

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

## Projects tracker (v1.20.0 → typed v1.28–1.29)

A main-column **🚀 Projects** card, backed by `GET/PUT /projects` KV (server-merged) + a
localStorage cache. Projects now have a **type**, each with its own pipeline (`PIPELINES` const):

- **software:** 💡 Idea → 🔬 Validate → 📝 Plan → 🛠️ Build → 🧪 Test → 🚀 Ship → 📈 Grow
- **property** (physical builds/renos on Q's two properties, the **House** & the **Cabin**):
  💡 Idea → 📐 Scope → 📋 Design/permits → 🧰 Materials/crew → 🔨 Build → 🎨 Finish → 🏡 Done

Both are 7 stages so the progress bar + summary spill line up. `PROJ_TYPES` sets each type's
label/emoji and `ship` index (software 5, property 6 = only "done" is complete).

- **Record:** `{id,name,type,property,area,people,url,repo,stage,next,notes,updated,deleted,pinned,order}`.
  Property extras: `property` (house|cabin), `area` (`PROP_AREAS`: inside/outside/plumbing/electric/
  handyman/cleaning/other), `people` (free-text names). `normalizeProject()` coerces/clamps per type.
- **Filter chips** appear when property projects exist (All · House · Cabin · trades). `projFiltered()`.
- **Calendar (both ways):** each property card has 📅 **schedule** → `openSchedModal` creates a Google
  Calendar event tagged via private `extendedProperties` (`midashApp=1` + project id). `loadProjEvents()`
  pulls those back per project (one query/account); the next event shows on the card and in the
  **"Scheduled this week"** strip (`renderPropWeek`, next 7 days across House/Cabin). Deleting a
  property project offers to remove its linked events (`cleanupProjEvents`).
- **People typeahead:** the People field (project modal) + Who field (scheduler) autocomplete against
  Google contacts (`attachContactTypeahead`, matches the text after the last comma, free-text fallback).
- **Neglect:** `projStale()` flags un-done projects amber >14d / red >30d; header/summary show "N need a
  push". `updateSyncAgo()` shows "synced Xm ago · N projects" (sync visibility, v1.35.0).
- **Sources:** ＋ Add (manual, with Type select) · ⇪ Import GitHub repos. Sort: neglected / **type** /
  stage / A–Z / manual.
- **Agent:** `list_projects`/`update_project`/`add_project` are type-aware (browser + Discord).

### Sync + deletes (v1.30–1.31, the P0 review fix)
- **Tombstones:** a delete is NOT an array removal — it sets `deleted:true` + a fresh `stamp()`, so the
  delete survives a stale-device merge (union-by-id + LWW alone can't express deletion). GC'd after 90d.
  `liveProjects()` filters tombstones at every read site. **`stamp()` = `max(now, newestUpdated+1)`** so a
  skewed device clock can't win/lose every conflict.
- **Server-side merge:** the browser used to blind-`PUT` the whole array (racing the Discord agent's
  read-modify-write on the same key). Now `/projects` PUT **merges** incoming into KV (tombstone-aware)
  and returns the merged set; the browser adopts it (`saveProjects` coalesces concurrent saves). Same
  `mergeProjects` logic is duplicated in `index.html` and `worker.js` — **KEEP IN SYNC**.

## Flow layer — the day list has three states (v1.45.0)

Built from how Q actually works a day (2026-08-11): he keeps one list, and the items on it are not
all the same kind of thing. A task is either **his to do**, **waiting on someone else**, or
**blocked behind another task**. Google Tasks only models the first, so the other two are miDash's.

- **Storage:** `GET/PUT /flow`, KV blob keyed by Google task id. **Deliberately not** the Google
  task's `notes` field: the Worker has no Google token, and the Discord agent (and any future cron
  nudge) has to be able to read this. Written only on a real state change — a few writes a day.
- **Entry:** `{taskId, title, waiting, waitingSince, chase, chaseId, after, afterId, updated}`.
  `title` is denormalized so Discord can render it without Google.
- **Buckets** (`taskBuckets` → `renderTasksList`): active list on top, then **Next up** (blocked,
  shows what it's behind), then **Waiting on** (who + how many days it's sat). Parked rows are muted
  with a one-click un-park (`unparkTask`). Only the active count drives the show-all toggle.
- **Auto-surfacing:** completing a task calls `releaseDependents()` — anything queued behind it has
  its block cleared and flashes "🔓 Unblocked: …". That's the payoff: he wires "pay CCs" behind
  "link CCs via Plaid" once, and never has to remember the link again.
- **The failed-account guard:** a blocked task un-blocks when its blocker leaves the open list. If a
  Tasks API call failed, `blockerOpen()` returns true regardless — otherwise one 429 would silently
  unblock everything. Unit-tested.
- **Chase:** waiting on a *person* rots unless chased, so a wait can carry a chase time that becomes
  a normal reminder in the existing `/reminders` queue (Discord DM). Un-parking cancels it.
- **`DAY_START_HOUR = 10`** — Q's day starts at 10am. `defaultReminderAt()` rolls to 10am rather
  than the old 8am, and both system prompts tell the agent never to nudge earlier.

## Natural language → the right object (v1.46.0)

The goal Q stated: "I talk in comfortable normal language and the agent takes all my nuances and
creates exactly what I need, no matter how complicated or what's tied to what."

**The regex capture parser cannot get there** — it is a fixed grammar, and every nuance it can't
express has to be taught one pattern at a time. So capture is now a two-lane road:

- **`captureIsComplex()`** decides the lane. Conditions (if/unless), sequencing (after/once/until),
  waiting language (hasn't/never replied/waiting on), multi-clause, or ≥18 words → the agent lane.
  Everything else keeps the instant, free, zero-token regex path. Deliberately conservative: a
  false positive costs a fraction of a cent, routing everything would make the common case slow.
- **`captureViaAgent()`** runs the tool loop HEADLESSLY on its own message array — a capture must
  not pollute the chat history, and must not inherit whatever was being discussed in the panel. It
  gets `CAPTURE_DIRECTIVE` ("he pressed a button and walked away — you cannot ask him anything"),
  acts, and reports one line into the capture flash. **Any failure falls straight back to the regex
  path**, so a capture is never lost.
- **`CONFIG.captureModel`** (default `claude-sonnet-4-6`) — complex captures are exactly where
  nuance is the point, so they get a smarter model than the chat default. Set to null to follow the
  picker. Simple captures never call the API at all.

### Watches — the third shape (task · reminder · **watch**)

A task is committed work. A reminder is a ping. A **watch** is a decision deferred to a moment:
*"call Bob by 10a if he hasn't emailed me before then."* The call may never need making, so
committing it as a task means ticking off a chore that resolved itself.

- `set_watch(at, who, then_task, then_notes)` queues it + schedules a normal reminder, so **Discord
  still fires on time** with the condition spelled out even if the dashboard never opens.
- `runDueWatches()` (browser, on the 60s poll) settles anything past its moment:
  **silent → `watchCommit()` finally creates the task**, carrying the original context plus what was
  checked and when; **they replied → nothing lands** and the flash says so.
- **Idempotence:** committing is not repeatable (it creates a Google Task), so a watch is claimed in
  `localStorage` (`midash_watch_done`) BEFORE acting — a failed resolve POST must not double-create.
  Same pattern as the bell's `midash_rem_alerted`.
- Renders in the Tasks card as **"Watching for"** (`#watch-strip`), with ✕ to cancel.

### Email as the condition oracle

Nearly all of Q's comms with the people on his list are email, so most conditions reduce to one
Gmail question. `checkEmailFrom(who, since)` resolves a name against Google Contacts
(`resolvePersonEmail`) and searches `from:<addr> after:<epoch>` across every connected account,
returning the newest match with subject/time. Exposed as the **`check_email_from`** tool so
"did Bob get back to me?" is answered from data. Browser-only by necessity — the Worker's copy of
the tool refuses honestly rather than guessing.

## Credit-card debt — deterministic payoff calculator (v1.33.0)

The CC Debt tool (☰ menu modal) now computes the payoff schedule **exactly** — the agent narrates it,
never does the math (LLMs make arithmetic errors on money).
- `computePayoff(cards, monthly, strategy)` (pure, unit-tested): month-by-month sim — accrue interest,
  pay every card its minimum, throw the remainder at the target (avalanche = highest APR, snowball =
  lowest balance), cascade as cards clear. Returns months-to-debt-free, total interest, payoff order with
  dates, and interest saved vs minimums-only. Rejects below-minimum / never-clears with a reason.
- The modal has a **card editor** (name/balance/APR/min per card, persisted in `/ccplan` as `cards[]`) +
  a live results panel. "Build my payoff strategy" hands the **computed** schedule to the agent.

## Weekly review (v1.37.0)

☰ Tools → 🗓️ **Weekly review** modal assembles, from data already in memory (`buildWeeklyDigest`):
projects needing a push, property work scheduled this week, who to reach out to (least-recently-shown
contacts), and a money snapshot. A "• due" marker shows on the link after 7 days (`updateWeeklyDue`,
`midash_lastreview`). "Plan my week with the agent" hands the rollup to the agent.

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
- **Notes are gated + clobber-guarded** (v1.32.0): `/notes` is behind `DASH_KEY` like everything
  else; PUT sends `X-Notes-Based-On: <djb2 hash>` and the Worker `409`s on a concurrent change so
  the client can offer keep-mine/keep-theirs instead of silently overwriting. `notesHash()` must
  match in `index.html` and `worker.js`.
- **XSS discipline** (v1.32.0): external strings (Gmail/ticket/contact/agent-set) render through
  `esc()` (body) or `escAttr()` (attribute — it also escapes single quotes). URLs from external
  sources go through `safeUrl()` (http(s) only — blocks `javascript:`/`data:`). Don't interpolate a
  raw variable into `innerHTML`; audit was done, keep it clean.
- **`color-mix()`** is used for tints — fine on modern Chrome/Safari (Q's setup).
- **Caching / updates:** after a push, GitHub Pages' CDN can serve the old file for a minute+.
  The **⚙️ → 🔄 Check for update** button (v1.27.2) reads the DEPLOYED version (same-origin,
  cache-busted — NOT raw.githubusercontent, which updates instantly and would loop) and, if newer,
  clears caches + unregisters the SW + reloads. Landing on a *new* build the first time still needs
  one hard-refresh (the old build has the old button).

## First-time / re-setup checklist

1. Google Cloud: OAuth consent screen has Q's Gmail as a Test User; client ID authorizes
   `https://qforgues.github.io` (and `http://localhost:8000`) as JS origins.
2. After any scope change, click **Connect Google** again (✕ the chip, reconnect) for fresh consent.
3. Worker: `wrangler deploy`; secret `ANTHROPIC_API_KEY` set; KV `NOTES` bound.
4. Add the 2nd account with **＋ account** on the dashboard.

---

## Backlog / next up

- [ ] **Bank Sync (BLOCKED on Dart):** the Dart Bank SFTP importer (42payments `/bank`) is built
      but blocked on **Adam Baker adding the Pi's egress IP `66.9.164.11` to Dart's allowlist**
      (the questionnaire listed the wrong IP). Waiting to hear back (as of 2026-07-02). Once
      access works, build the BAI2/CSV importer. ⚠️ **Never handle Q's bank password** — he enters
      it into 42payments' own form; we only verify via logs. (Dart's Credit/Debit is backwards.)
- [ ] **Notes: tombstone/merge** like projects (currently conflict-guarded, not merged).
- [ ] **Discord weekly-digest push** — the rollup exists (`buildWeeklyDigest`); add a cron + send.
      (The cron plumbing now exists — `scheduled()` in `worker.js` — so this is a smaller lift.)
- [x] **In-dashboard reminder bell (v1.43.0):** header 🔔 with a badge; when a pending reminder
      comes due (detected locally from the `loadReminders` cache) it rings — soft WebAudio chime +
      tab-title flash + an OS notification when the tab is backgrounded (opt-in via the bell menu).
      Idempotent per reminder id (localStorage). The at-desk layer atop the Discord push.
- [x] **Reminders — miDash-owned Discord-DM push (v1.41.0):** KV queue + 1-min cron;
      `set_reminder`/`list_reminders`/`cancel_reminder` tools (browser + Discord agent); capture bar
      "⏰ Remind me to…" also fires a Discord ping when a time is given. Needs secrets
      `DISCORD_BOT_TOKEN` + `DISCORD_USER_ID`.
- [ ] Prompt caching on the system block (`cache_control` in `worker.js`) to cut per-turn input cost.
- [ ] **Static IP for the Pi** — Q wants FREE only (noted Oracle Cloud always-free VM); staying on
      home IP for now.
- [x] Deterministic CC-debt payoff calculator (v1.33.0).
- [x] Property/physical projects — House/Cabin, trades, people, calendar (v1.28–1.29).
- [x] External code-review hardening — tombstones, server merge, chat repair, auth, XSS, tests (v1.31–1.33.1).
- [x] Richer Projects — idea→shipped tracker card (v1.20.0).

## Quick "where were we" log

- v1.6.x: top menu collapsed to a one-row hover-dropdown bar; agenda 60 / notes 40;
  full-width content; per-account row/badge colors; theme color picker; one-click
  unsubscribe via `List-Unsubscribe`; Gmail 404 + 429 fixes; Notes synced via Worker KV.
- v1.16–1.19: 42payments finance card + tools; Credit-Card Debt card + payoff plan;
  La Palma TV pinned atop the Projects quick-links.
- v1.20.0: **Projects tracker** card (idea→shipped board, `/projects` KV, agent tools).
- v1.21.0: **version-driven look** (major→design, minor→colors) + **hamburger gated**.
- v1.22–1.26: Tracker42 ticket writes; Switchboard; Discord `/agent` + Pi migration; 42payments →
  Pi; silent Google renewal; Phase B contacts/Stay-connected overhaul (cross-account, tags,
  least-shown reach-out, contacts manager, from-account selector).
- v1.27.x: 🔄 check-for-update button (reads deployed version); Google account pills moved into the
  Switchboard; collapsible cards; Tickets ‖ Tasks + Stay-connected ‖ Notes 50/50 splits; date/time
  reformat; dropped `contacts.other.readonly` (fixed "Something went wrong" connect); **Fable 5** model;
  CC Debt → ☰ menu modal; inbox "Show:" filters → single 🚫 unsubscribe icon.
- v1.28–1.29: **property/physical projects** — type-aware pipelines, House/Cabin, trades, people,
  Google Calendar (both ways).
- v1.30–1.31: union-merge (seeding can't clobber) → **tombstones + server-side merge** (P0 review fix);
  auth hardening (narrow fail-open, constant-time, rate limit); XSS fixes; token auto-refresh; notes
  clobber-guard; calendar idempotency; **`tests.html`** (56 assertions).
- v1.33.0–1.33.1: **deterministic debt calculator**; two real chat-repair bugs (consecutive-user-turn,
  tool_result ordering) fixed after external review.
- v1.34–1.37: property "Scheduled this week" strip + contact typeahead; sync visibility; tool-schema
  single-source + `/tools`; **Weekly review** rollup.
- v1.38–1.40: panels start collapsed + Discord light KV-quota fix; boot-time silent Google re-grant;
  agent reminders set dates from "tomorrow/next tue".
- v1.41.0: **Reminders — miDash-owned Discord-DM push.** KV `reminders` queue + 1-min Cron Trigger
  (`scheduled()` → `fireDueReminders` → Discord REST DM); `set_reminder`/`list_reminders`/
  `cancel_reminder` tools (browser via `resolveAt`+`POST /reminders`; Discord agent via
  `resolveAtServer`); capture bar "⏰ Remind" also fires a ping when a time is given; `resolveAt`
  unit-tested (66 assertions). Established the **"own the brain; third parties are dumb pipes"**
  spine. Also: switchboard Google modal tidy (single connect affordance, ✕ close). Needs secrets
  `DISCORD_BOT_TOKEN` + `DISCORD_USER_ID`.
- v1.42.0: **Dashboard consolidation pass.** Switchboard → a header **🎛️ pill** (LED = worst state;
  click to expand the lights + re-check) — reclaims the top card, status always visible. **Reminders
  now render in the Tasks card** ("Tasks & Reminders": pending list with ✕-cancel; `loadReminders`/
  `cancelReminderId`/`fmtReminderWhen`) — the home the in-dash bell will ring from. **☰ menu
  decluttered:** Weekly review + CC Debt moved to the ⚙️ gear menu; the live GitHub-repos list
  dropped (dup of the Projects card); Contacts is now a "Manage contacts" button opening the existing
  manager (not a 2nd live list). Capture bar slimmed to a top strip. (`loadProjects` is now dead code.)
- v1.43.0: **In-dashboard reminder bell.** Header 🔔 (badge + ring animation); `checkDueReminders`
  rings due reminders from the `loadReminders` cache — WebAudio `playChime`, `startTitleFlash`, and an
  OS `Notification` when `document.hidden` (permission opt-in via the bell menu). Once-per-id via
  localStorage; polls the pending list every 60s, ticks every 20s. Discord stays the guaranteed channel.
- v1.44.0: **Resilient boot + better theme.** Boot is now a `boot()` runner that isolates every init
  in its own try/catch (a single throw used to cascade — `v?` version, panels not collapsing, weekly
  modal not wiring its Close). `showVersion` runs first; failures `console.error("[boot] <step> failed")`.
  Theme generator rebuilt: **curated `THEME_PALETTES`** (coloured darks like navy/forest/plum + soft
  lights — no more "black + harsh accent"), pattern ink is now a **subtle tint** so patterns read as soft
  texture, plus a new `soft` mesh pattern and repeat-avoidance between rolls.
- v1.44.1: **Fixed the root boot throw.** `renderSwitchboard()` declared `reds`/`ambers`/`checking`
  as `const` inside the `if(sum){}` block but the header pill-LED line read them at function scope →
  `ReferenceError` every render. It drew the gray chips then threw before the checks resolved, so the
  switchboard sat on "checking…" forever — and via `initSwitchboard()` this was the exact throw that
  cascaded into `v?`/collapse/weekly (the v1.44.0 isolated boot masked it everywhere but the
  switchboard itself). Hoisted the three counts to function scope. Root cause: introduced by the
  v1.42.0 pill-LED addition.
- v1.44.2–1.44.4: **Reminder capture rework + Tasks UX.** The "⏰ Remind me to…" bar now schedules a
  Discord ping for **any** reminder (timed → that time; date-only → 9am; **no day/time → a same-day
  nudge ~3h out**, guarded away from 9pm–7am → next 8am — `defaultReminderAt()`), decoupled from
  Google Tasks so it fires even if Tasks write fails; it also adds the Task, and only falls back to
  Notes if *both* fail (never task+note together). `parseReminder` strips a leading "remind me
  to/remember to/reminder:" and capitalizes so names read as actions. **Tasks card**: retired the
  3-at-a-time pager (shows ALL), and completing a task removes just that row in place — no reload, no
  page reset, no scroll jump (`renderTasksList`/`wireTaskRow`; clearing #14 used to snap back to 1–3).
- v1.44.5: **update_task** agent tool — reschedule/rename a Google Task (change due date). Fixed the
  agent telling Q to edit Tasks manually.
- v1.44.6: **Minimalist icon system + menu reorg.** Replaced emoji in the chrome (header bell/gear/menu/
  switchboard, card headers, capture modes, Tracker tabs, menus, reminders strip) with an inline-SVG
  set (`ICON_PATHS`/`ic()`/`data-ic`+`renderIcons`). Gear menu = icon pills (Appearance, Weekly, CC
  Debt, Check-update, Install); **Dashboard passphrase moved to the ☰ burger**; **Contacts removed from
  the menu** (lives with the Stay-connected card). Fixed the **Google switchboard light** going amber
  after an update (it ran before Google finished connecting — now re-checks in `afterAuth`).
  ⚠️ Long tail of emoji remains in transient flashes / deep features (property-area glyphs, model
  picker, agent chat, flash ticks ✓🎉) — de-emoji opportunistically next.
- v1.44.7–1.44.12: tasks show-all toggle; agent can clean up Google Contacts (`list_contacts` +
  `delete_contacts`); portrait dropdown fix + dictation into the capture bar (Web Speech API, no
  backend) + no forced Google re-consent; capture bar became a radio row of icons; the Switchboard
  now surfaces WHY a Google silent re-grant failed.
- v1.45.0: **Flow layer — waiting-on / blocked-by.** The day list stopped pretending every item is
  the same kind of thing. New `/flow` KV blob + `set_waiting`/`clear_waiting`/`block_task`/
  `list_waiting` tools (browser AND Discord — the first task-shaped tools that work without Google).
  Tasks card splits into active / **Next up** / **Waiting on**; completing a blocker auto-surfaces
  what it freed (`releaseDependents`). A wait can carry a **chase** time that rides the existing
  reminder queue. `DAY_START_HOUR = 10`. 22 new assertions (94 total), including a mutation-checked
  guard that a Tasks API failure can't silently unblock the board.
- v1.45.1: **Three capture bugs, found by using it for real.** (1) `parseReminder` picked the first
  DATE RULE that matched instead of the date word appearing earliest in the TEXT — "call Bill at
  10am tomorrow — he never replied about **today**" scheduled 10am *today*, already past, so no ping
  was created and the capture fell through to a Notes line. Now the earliest match in the string
  wins (ties keep rule order). (2) A pure NOTIFICATION ("if Bill replies then let me know") also
  created a Google Task — a chore he can never *do*. `isNotifyOnly()` now gives those a ping only,
  and both system prompts teach the distinction. (3) The context Q typed was thrown away: nothing
  ever reached a Google Task's `notes` field (`createTask` had no notes param, and neither did the
  agent's `create_task` schema). Now `splitDetail()` keeps the action on the task line, the original
  text goes in the task notes, and the Discord ping carries the why. Also: a time that has already
  passed says so instead of silently producing nothing. 19 new assertions (113 total), each
  mutation-checked against the old behaviour.
- v1.45.2: **Talk normally.** Three more from real use: (1) the instruction wrapper leaked into the
  thing to do — "Set a reminder to call Bob jones…" became a task *titled* that. A much wider
  `LEADIN` regex now strips "set/add/create a reminder|task|note to", "note to self:", "I need to",
  "can you please…", stacked up to 3 deep — while leaving "reminders are useful" alone. (2) **"10a"
  and "3p" parsed as NO TIME AT ALL** (`\b` never matches between "10" and "a"), so "call Bob by
  10a" silently fell back to a default hour. Added a shorthand rule that requires the letter be
  glued to the number or follow at/by/@, so "buy 5 apples" can't become 5am. (3) A CONDITIONAL
  ("call Bob by 10a **if** he doesn't email me first") was committed as a task, though the call may
  never need making — `hasCondition()` routes those to a reminder only, excluding "if" as a verb
  complement ("check **if** the package arrived" is still a task). 21 new assertions (134 total).
- v1.46.0: **Natural language → the right object.** All three pieces of the plan, in one pass.
  (1) **Capture routes to the agent** when the sentence carries nuance (`captureIsComplex`), running
  a headless tool loop on its own message array, with a hard fallback to the regex path so nothing
  is lost. (2) **Watches** — the conditional primitive: `/watch` KV queue + `set_watch`/
  `list_watches`/`cancel_watch`, the task created ONLY if the condition holds, claimed in
  localStorage first so a failed resolve can't double-create. (3) **Email watch** —
  `checkEmailFrom` + the `check_email_from` tool answer "has X emailed?" from Gmail across all
  accounts, which is what actually settles a watch. Q's canonical sentence now works end to end:
  *"call Bob by 10a if he doesn't email me before then"* → ping at 10a, inbox checked, task only if
  Bob stayed quiet. 18 new assertions (152 total).
- v1.46.1: removed the in-card "＋ add a task…" form (`#task-add`, `initTasksAdd`, `.task-add` CSS,
  boot step). It was a third way to do what the capture bar already does better — the bar parses a
  due date, carries context into the task notes, and routes anything nuanced to the agent; the bare
  form did none of that and quietly produced context-free tasks.
- v1.46.2: **Switchboard remedy state.** The Discord card shows the WORST of inbound (Pi bot
  heartbeat) and outbound (Worker→Discord push), but its only action was "🔔 Send test DM" — which
  exercises OUTBOUND. So the common failure (Pi bot down) showed a red light, a passing test DM, and
  a "Re-check" that changed nothing. Hit for real 2026-08-11. A check can now return a
  `remedy {title, cmd, note}`, rendered as a bordered block with the exact `ssh claudeclaw` +
  `systemctl restart midash-discord` commands and a 📋 Copy button (clipboard API, with a
  select-range fallback). The footer text also stops pointing at the test DM as proof when it's the
  inbound half that's down. `fmtAgo` so a dead bot reads "3 hr", not "184 min". Verified in headless
  Chrome at 320/500/900px: no page overflow, the command block scrolls inside its own box.
- **Now:** waiting on Dart Bank IP allowlist for Bank Sync; spend cap set. Reminders (Discord DM +
  in-dash bell), consolidation, curated theme, boot fix, capture/tasks rework, update_task, the
  icon pass, and the flow layer are all live + on `main`.
  **Next on the workflow track** (designed 2026-08-11, in order): (1) **rollover ritual** — an
  end-of-day "what didn't happen" nudge that pushes leftovers and asks *when*, plus a
  pushed-N-times callout; (2) **places** — errand/USPS/MI grouping so a trip is planned once, and
  "when I'm next in MI" tasks that carry no date at all; (3) **email watch** — for tasks tied to a
  person whose channel is email, scan just those senders and propose the task update. Also open:
  finish de-emoji sweep, "shuffle look" button, Discord weekly-digest.
