# miDash

My personal command center — calendar, mail, work, projects, kids, and play in one
single-file dashboard, plus an embedded AI chat agent. Static site, hosted free on
GitHub Pages.

## Edit locally, push live

Everything is plain files — no build step.

```bash
# edit
open index.html          # or your editor; tweak the CONFIG block at the bottom

# preview locally
python3 -m http.server   # then visit http://localhost:8000

# push live
git add -A && git commit -m "update" && git push
```

GitHub Pages redeploys automatically on every push (usually live in ~30s).

## Customize

All your links live in the `CONFIG` object at the bottom of `index.html`. Add,
remove, or rename sections and links freely — no other code to touch. Google links
auto-pin to `CONFIG.account` so they always open your personal account, not work.

## Live data (today's events + important mail)

The "Today" panel can show your real calendar and Gmail by signing you in *in your
browser* — no server, your data never leaves your machine. One-time setup:

1. Go to <https://console.cloud.google.com> → create a project (e.g. "miDash").
2. **APIs & Services → Library** → enable **Google Calendar API** and **Gmail API**.
3. **APIs & Services → OAuth consent screen** → choose *External*, fill the app name,
   and under *Test users* add your personal Gmail. (Testing mode is fine — no
   verification needed for your own account.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   *Web application*. Under **Authorized JavaScript origins** add:
   - `https://qforgues.github.io`
   - `http://localhost:8000` (for local preview)
5. Copy the **Client ID** and paste it into `CONFIG.googleClientId` in `index.html`.
6. Commit & push. Click **Connect Google** on the dashboard once — done.

Scopes used are read-only (`calendar.readonly`, `gmail.readonly`). The access token is
cached in your browser only.

## Projects

The Projects card auto-lists your most recently updated GitHub repos
(`CONFIG.githubUser`). No setup needed for public repos.

## The chat agent

The chat widget (bottom-right) talks to a small backend **you** control that holds
your Anthropic API key.

> ⚠️ Never put your API key in `index.html` — it's public on GitHub Pages.

Two ready-made backends are included:

- **`worker.js`** — deploy to a free Cloudflare Worker (simplest, always-on).
- **`server.js`** — run on your Raspberry Pi (the one you already use for Discord),
  zero dependencies, Node 18+.

Once your backend is running, paste its URL into `CONFIG.chatEndpoint` in
`index.html`, commit, and push. The status dot in the chat header turns green when
configured.

Because the agent is just an HTTP endpoint, the **same** backend can power other
clients you run — e.g. your Pi's Discord bot — giving you one shared agent across the
dashboard, Discord, and anything else.

## Files

| File         | Purpose                                  |
|--------------|------------------------------------------|
| `index.html` | the dashboard (edit `CONFIG` here)       |
| `llms.txt`   | tells AI agents/crawlers what this is    |
| `worker.js`  | Cloudflare Worker chat backend           |
| `server.js`  | Raspberry Pi / Node chat backend         |

## Keep secrets out of git

Never commit your API key. Set it as an environment variable (`server.js`) or a
Wrangler secret (`worker.js`). A `.gitignore` is included to help.
