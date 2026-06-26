# miDash — Project State & Handoff

> Read this first to resume work. It's the single source of truth for where the
> project stands, how it's wired, and what's next. Keep it updated as we go.

**Current version:** `1.7.0` (see `CONFIG.version` in `index.html`)
**Owner:** Q — quentin.forgues@gmail.com
**Last updated:** 2026-06-24

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

## Accounts & keys

- **Google OAuth client ID (public, safe to commit):**
  `649111264239-gro8ns552nso1398knfv03hc63rb5o8d.apps.googleusercontent.com`
- **Connected Google accounts:** `quentin.forgues@gmail.com` (alias "Mine"),
  `quentin@portal42.us` (alias "Portal42")
- **Anthropic key:** lives ONLY as a Wrangler secret on the Worker
  (`wrangler secret put ANTHROPIC_API_KEY`). Never in the repo.
- **KV namespace:** `NOTES`, id `f095586747ee4a47b524082986e8f725` (in `wrangler.jsonc`)
- **Model:** switchable from the chat header (picker). Default `claude-haiku-4-5`
  (cheapest); options `claude-sonnet-4-6`, `claude-opus-4-8`. The dashboard sends
  `model` in the chat POST body; the Worker validates it against `ALLOWED_MODELS`
  and falls back to `DEFAULT_MODEL`. **This is the metered Anthropic API — billed
  per token, separate from any Max plan. Cap spend in the Anthropic Console.**
- **OAuth scopes:** `openid email`, `calendar.events`, `gmail.modify`, `gmail.send`,
  `contacts.readonly` (People API → Contacts dropdown + daily reach-out),
  `tasks.readonly` (Google Tasks). Scopes added in v1.7.0 require a one-time
  reconnect, and the **People API + Tasks API must be enabled** in the Google Cloud
  project behind the OAuth client.

---

## Files

| File            | Purpose |
|-----------------|---------|
| `index.html`    | The whole dashboard — UI, CSS, JS, CONFIG. **Edit `CONFIG` at the bottom of `<script>`.** |
| `worker.js`     | Cloudflare Worker: chat agent (Anthropic) + `/notes` KV storage. The "brain." |
| `wrangler.jsonc`| Worker config incl. KV binding. |
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
`mark_read`, `list_events`, `delete_event`, `read_notes`.
All are **multi-account aware** (sweep every connected account, tag results with
`account`). Reply/trash/delete pop an on-screen `confirm()` first.

---

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
- [ ] Optional: scheduled briefings (daily agenda/inbox digest), more agent tools
      (create_event, send_email), school-portal link for Kids, richer Projects.

## Quick "where were we" log

- v1.6.x: top menu collapsed to a one-row hover-dropdown bar; agenda 60 / notes 40;
  full-width content; per-account row/badge colors; theme color picker; one-click
  unsubscribe via `List-Unsubscribe`; Gmail 404 + 429 fixes; Notes synced via Worker KV.
- Next session likely starts on the **Pi/claw42** cleanup.
