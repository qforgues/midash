/**
 * miDash chat backend — Cloudflare Worker (tool-using agent)
 * --------------------------------------------------
 * Holds your Anthropic API key as a secret and runs the chat agent for the
 * dashboard. The model can call tools (search/reply/trash/etc.); the TOOLS are
 * defined here, but they are actually *executed in your browser* using your own
 * Google login — so this Worker never sees or needs your Google credentials,
 * and your API key never reaches the browser.
 *
 * Deploy:
 *   1. npm i -g wrangler && wrangler login
 *   2. cd ~/miDash && wrangler deploy worker.js --name midash-chat
 *   3. wrangler secret put ANTHROPIC_API_KEY        (paste your key)
 *   4. Put the printed https://midash-chat.<you>.workers.dev URL into
 *      CONFIG.chatEndpoint in index.html, then push.
 */

const ALLOWED_ORIGIN = "https://qforgues.github.io"; // only your site may call this

// 42payments — Q's business finance app (FreshBooks-backed invoicing/expenses/income).
// The browser's finance_* tools call this Worker's /finance proxy, which attaches the
// X-API-Key secret server-side and forwards here. The key NEVER reaches the browser.
//   wrangler secret put PAYMENTS_API_KEY
const PAYMENTS_BASE = "https://42payments.myeasyapp.com/api/ext";

// Models the dashboard may pick from (the picker sends one of these strings).
// Haiku is the default — it's ~5x cheaper than Sonnet for the same chat.
// NOTE: this is the metered Anthropic API (billed per token, separate from any
// Max subscription). Haiku keeps the per-message cost in the fractions-of-a-cent range.
const ALLOWED_MODELS = new Set([
  "claude-haiku-4-5",   // cheapest  ($1 / $5 per Mtok)
  "claude-sonnet-4-6",  // balanced  ($3 / $15)
  "claude-opus-4-8",    // smartest  ($5 / $25)
]);
const DEFAULT_MODEL = "claude-haiku-4-5";
// Adaptive thinking + the effort parameter are supported on Sonnet 4.6 / Opus 4.8 but
// NOT on Haiku 4.5 (sending them to Haiku 400s). So we only enable them on the smart models.
const SMART_MODELS = new Set(["claude-sonnet-4-6", "claude-opus-4-8"]);

const SYSTEM = `You are the assistant embedded in Q's personal dashboard (miDash).
You can read Q's Google Calendar (across ALL of his connected Google accounts and ALL
calendars), create calendar events, delete events, read/reply/trash/archive/mark-read his
Gmail, send new emails, read/create/complete his Google Tasks, and read his Notes scratchpad
— via the provided tools. Tools run in Q's browser using his own Google logins. Be concise
and friendly.

Q's flow is idea → reality: ideas live in his Notes (read_notes), and Tasks are the
actionable layer. When he says things like "turn my notes into tasks", "make these ideas
real", or "what should I do next", read_notes first, then create a task per actionable item
with create_task. To mark something done, list_tasks to find its listId/taskId, then
complete_task.

Projects (the bigger picture): Q tracks his software/website/app projects on a board that
runs idea → validate → plan → build → test → ship → grow. Use list_projects to see them
(it returns each project's stage, progressPct, its "next" action, and lastTouchedDays — a
high lastTouchedDays means it's being neglected). His north star is "keep every project
moving, leave none behind", so for "what should I work on / what's stalling / how are my
projects" call list_projects and steer him to the most neglected ones and their next action.
Use update_project to advance a stage or set the next action (e.g. "move La Palma to ship"),
and add_project when he wants to start tracking a new idea. These act immediately (no confirm).

Portal42 / Tracker42 (Q's ticketing system): list_tracker_notifications shows his Tracker42
notifications newest-first (ticket status changes, comments, approvals, QA pass/fail, releases),
with meta.unread_count as the unread badge. Use it for "any new Portal42 tickets?", "what's new
on the tracker", or "did anything change on TKT-…". get_ticket fetches one ticket's status by id,
but the ticket endpoints are still rolling out — if it returns an "Unknown action" error, that
means tickets aren't live yet (not a failure); say so and fall back to the notification feed.

Multiple accounts:
- Q may connect more than one Google account (e.g. a personal gmail and a work address).
  Tools that read (search_emails, list_events) automatically cover EVERY connected
  account and each result is tagged with its "account". Never claim you can't see an
  account — if it's connected on the dashboard, your tools already include it. If a
  requested account truly isn't connected, say so and suggest clicking "＋ account".
- For actions on a specific message/event, pass the "account" from the item you're
  acting on so it targets the right inbox/calendar.

Guidelines:
- When the user refers to "the latest email from X" or similar, first call
  search_emails to find the message id (and its account), then act on it.
- To remove calendar events: call list_events, then delete_event with the event's
  account, calendarId, and eventId. Events on read-only calendars (like Birthdays)
  can't be deleted — tell Q if that happens. Only delete events where canEdit is true.
- reply_email, trash_email, delete_event, create_event and send_email pop a confirmation
  dialog on Q's screen, so just call the tool when asked — do NOT ask for permission again
  in text. If a tool returns cancelled:true, respect it and don't retry.
- To add something to the calendar, call create_event with an ISO start (and end if known).
  To email someone new, call send_email; for a reply to an existing thread, use reply_email.
- read_notes returns Q's free-form scratchpad; use it as context when he references
  "my notes", "my ideas", or asks you to draft from what he jotted down.
- After acting, briefly confirm what you did. Draft replies in Q's voice: warm, brief, direct.

Business finances (42payments):
- You can see and act on Q's business money via the finance_* tools (FreshBooks-backed):
  finance_summary (start here for "how's the business doing?"), finance_list
  (invoices/expenses/clients/payments), finance_profit_loss, and the writes
  finance_create_invoice, finance_log_expense, finance_add_client, finance_mark_invoice_paid.
- Money comes back as { amount, code } (e.g. {"amount":"500.00","code":"USD"}).
- The write tools pop an on-screen confirm, so just call them when asked — don't ask again in
  text; if a tool returns cancelled:true, respect it and don't retry.
- If a finance tool returns not_ready:true, the app is running but FreshBooks isn't connected
  yet — tell Q to sign in once at 42payments. If it returns offline:true, the app isn't
  reachable right now — say finances are temporarily unavailable and to retry later. Neither
  is your fault; don't treat them as errors.`;

const TOOLS = [
  { name: "search_emails",
    description: "Search Gmail across ALL connected accounts. Returns messages with id, account, from, subject, date, snippet. Use Gmail search syntax in 'query' (e.g. 'in:inbox is:unread', 'from:sam newer_than:7d', 'category:promotions').",
    input_schema: { type: "object", properties: { query: { type: "string" }, max: { type: "integer", description: "max results per account, default 5" } }, required: ["query"] } },
  { name: "get_email",
    description: "Get the full body and headers of one email by id. Pass 'account' if known.",
    input_schema: { type: "object", properties: { id: { type: "string" }, account: { type: "string", description: "the account email the message belongs to" } }, required: ["id"] } },
  { name: "reply_email",
    description: "Reply to an email by id, in the same thread. Q confirms on screen before it sends. Pass 'account' from the message.",
    input_schema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" }, account: { type: "string" } }, required: ["id", "body"] } },
  { name: "trash_email",
    description: "Move an email to Trash by id. Q confirms on screen. Pass 'account' from the message.",
    input_schema: { type: "object", properties: { id: { type: "string" }, account: { type: "string" } }, required: ["id"] } },
  { name: "archive_email",
    description: "Archive an email (remove it from the inbox) by id. Pass 'account' from the message.",
    input_schema: { type: "object", properties: { id: { type: "string" }, account: { type: "string" } }, required: ["id"] } },
  { name: "mark_read",
    description: "Mark an email as read by id. Pass 'account' from the message.",
    input_schema: { type: "object", properties: { id: { type: "string" }, account: { type: "string" } }, required: ["id"] } },
  { name: "list_events",
    description: "List calendar events for the next N days (default 7) across ALL connected accounts and calendars. Each event includes account, calendarId, eventId, summary, start, end, allDay, location, and canEdit. Use a larger N (e.g. 365) to find sparse events like birthdays.",
    input_schema: { type: "object", properties: { days: { type: "integer" } }, required: [] } },
  { name: "delete_event",
    description: "Delete a calendar event. Requires account, calendarId, and eventId (all from list_events). Q confirms on screen. Read-only calendars (e.g. Birthdays) will fail.",
    input_schema: { type: "object", properties: { account: { type: "string" }, calendarId: { type: "string" }, eventId: { type: "string" }, summary: { type: "string", description: "for the confirm dialog" } }, required: ["account", "calendarId", "eventId"] } },
  { name: "read_notes",
    description: "Read Q's free-form Notes scratchpad from the dashboard. Use when he references his notes/ideas or asks you to draft from them.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "create_event",
    description: "Create a NEW calendar event. Q confirms on screen before it's created. Give 'start' (and ideally 'end') as ISO 8601 local time, e.g. 2026-07-02T15:00:00. For an all-day event, pass a date-only 'start' (YYYY-MM-DD) and allDay:true. Defaults to Q's primary calendar on his primary account unless 'account' is set.",
    input_schema: { type: "object", properties: { summary: { type: "string" }, start: { type: "string" }, end: { type: "string" }, allDay: { type: "boolean" }, location: { type: "string" }, description: { type: "string" }, account: { type: "string" } }, required: ["summary", "start"] } },
  { name: "send_email",
    description: "Send a NEW email (not a reply — use reply_email for replies). Q confirms on screen before it sends. Sends from his primary account unless 'account' is set.",
    input_schema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, account: { type: "string" } }, required: ["to", "subject", "body"] } },
  { name: "list_tasks",
    description: "List Q's open Google Tasks across ALL connected accounts. Each item has title, account, listId, taskId, due. Use listId+taskId to complete a task.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "create_task",
    description: "Add a NEW Google Task (a to-do). This is how you turn an idea or a note into an actionable task. Optional 'due' as YYYY-MM-DD. Goes to Q's default task list on his primary account unless 'account' is set. Acts immediately — no confirmation needed.",
    input_schema: { type: "object", properties: { title: { type: "string" }, due: { type: "string" }, account: { type: "string" } }, required: ["title"] } },
  { name: "complete_task",
    description: "Mark a Google Task done. Needs account, listId and taskId (from list_tasks). Acts immediately — no confirmation needed.",
    input_schema: { type: "object", properties: { account: { type: "string" }, listId: { type: "string" }, taskId: { type: "string" }, title: { type: "string", description: "for context" } }, required: ["listId", "taskId"] } },

  // ---- Projects board (Q's idea→shipped tracker, miDash-owned) ----
  { name: "list_projects",
    description: "List Q's tracked projects (his software/website/app ideas → shipped products), most-neglected-first. Each item has name, stage (idea|validate|plan|build|test|ship|grow), progressPct, next (the next action to push it forward, may be null), lastTouchedDays (days since last touched; high = neglected), stale (boolean), url, repo. Use for 'what should I work on / what's stalling / how are my projects'.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "update_project",
    description: "Update one of Q's tracked projects, matched by name (case-insensitive, partial match ok). Set any of: stage (one of idea|validate|plan|build|test|ship|grow), next (the single next action), notes. Touches its last-updated so it stops looking neglected. Acts immediately — no confirmation.",
    input_schema: { type: "object", properties: { name: { type: "string" }, stage: { type: "string", enum: ["idea","validate","plan","build","test","ship","grow"] }, next: { type: "string" }, notes: { type: "string" } }, required: ["name"] } },
  { name: "add_project",
    description: "Add a NEW project to Q's tracker. Needs name. Optional stage (default idea), next (next action), url (live site), repo (owner/repo). Use when Q wants to start tracking a new idea. Acts immediately — no confirmation.",
    input_schema: { type: "object", properties: { name: { type: "string" }, stage: { type: "string", enum: ["idea","validate","plan","build","test","ship","grow"] }, next: { type: "string" }, url: { type: "string" }, repo: { type: "string" } }, required: ["name"] } },

  // ---- Portal42 / Tracker42 (Q's ticketing system, read-only) ----
  { name: "list_tracker_notifications",
    description: "List Q's Portal42 (Tracker42) notifications, newest-first. Each has id, type (comment|status_change|assignment|approval|rejection|release|qa_pass|qa_fail), title, message, is_read, created_at (ISO-8601 UTC), and ticket_id/ticket_number/ticket_title when it's about a ticket. The result's meta.unread_count is the unread badge. Use for 'any new Portal42 tickets/notifications?' or 'what's new on the tracker'.",
    input_schema: { type: "object", properties: { since: { type: "integer", description: "only return notifications with id greater than this (default 0 = recent)" }, limit: { type: "integer" } }, required: [] } },
  { name: "get_ticket",
    description: "Get one Portal42 ticket's status/details by numeric id. NOTE: the ticket endpoints are still being rolled out — until they're live this returns an 'Unknown action' error; treat that as 'tickets aren't available yet', not a failure, and use list_tracker_notifications instead.",
    input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },

  // ---- 42payments (Q's business finances) ----
  // Money in results is { amount, code }, e.g. {"amount":"500.00","code":"USD"}. The tool may
  // return {not_ready:true} (app up but FreshBooks not connected — Q must sign in once at
  // 42payments) or {offline:true} (app not reachable) — treat both as "finances unavailable",
  // not a failure, and tell Q plainly. Writes pop an on-screen confirm before they fire.
  { name: "finance_summary",
    description: "One-call rollup of Q's business: revenue, outstanding, expenses, netProfit, currency, counts. Use this first for 'how's the business doing?'.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "finance_list",
    description: "List finance records. 'type' picks the dataset: invoices | expenses | clients | payments. For invoices you may pass 'status' (FreshBooks v3_status, e.g. 'paid','outstanding') and 'limit' (<=100).",
    input_schema: { type: "object", properties: { type: { type: "string", enum: ["invoices","expenses","clients","payments"] }, status: { type: "string" }, limit: { type: "integer" } }, required: ["type"] } },
  { name: "finance_profit_loss",
    description: "Profit & Loss report between two dates (YYYY-MM-DD). Pass 'start' and 'end'.",
    input_schema: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } }, required: ["start","end"] } },
  { name: "finance_create_invoice",
    description: "Create an invoice for a client. Needs clientId and amount (a plain number; currency defaults USD). Optional description, dueDate (YYYY-MM-DD). Q confirms on screen before it's created.",
    input_schema: { type: "object", properties: { clientId: { type: "string" }, amount: { type: "number" }, description: { type: "string" }, dueDate: { type: "string" }, currency: { type: "string" } }, required: ["clientId","amount"] } },
  { name: "finance_log_expense",
    description: "Log a business expense. Needs amount (plain number; currency defaults USD). Optional vendor, date (YYYY-MM-DD), notes, categoryid. Q confirms on screen.",
    input_schema: { type: "object", properties: { amount: { type: "number" }, vendor: { type: "string" }, date: { type: "string" }, notes: { type: "string" }, categoryid: { type: "string" }, currency: { type: "string" } }, required: ["amount"] } },
  { name: "finance_add_client",
    description: "Add a client. Provide at least one of organization, firstName, lastName, email. Q confirms on screen.",
    input_schema: { type: "object", properties: { organization: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" }, email: { type: "string" } }, required: [] } },
  { name: "finance_mark_invoice_paid",
    description: "Record payment on an invoice — pays its FULL outstanding balance. Needs invoiceId (from finance_list type:invoices). Optional method (e.g. 'Check'). Q confirms on screen.",
    input_schema: { type: "object", properties: { invoiceId: { type: "string" }, method: { type: "string" } }, required: ["invoiceId"] } },
];

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors() } });
}

// Shared-passphrase gate for /chat and /notes — stops anyone who finds the URL from
// spamming the metered Anthropic API or reading/writing the Notes. The dashboard sends
// "Authorization: Bearer <passphrase>"; we compare it to the DASH_KEY secret.
//   wrangler secret put DASH_KEY        (choose any passphrase)
// FAIL-OPEN by design: if DASH_KEY isn't set yet, requests are allowed (same as before),
// so deploying this code never locks you out. Enforcement starts the instant you set the
// secret. To disable later: `wrangler secret delete DASH_KEY`.
function authed(request, env) {
  const secret = (env.DASH_KEY || "").trim();            // tolerate a trailing newline/space in the secret
  if (!secret) return true;                              // not configured → open (set the secret to enforce)
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return !!m && m[1].trim() === secret;
}

// Notes read/write. Access is gated upstream by authed() once DASH_KEY is set.
async function handleNotes(request, env) {
  if (!env.NOTES) return json({ error: { message: "Notes storage not configured — create a KV namespace bound as NOTES (see README)." } }, 501);
  if (request.method === "GET") {
    const notes = (await env.NOTES.get("notes")) || "";
    return json({ notes });
  }
  if (request.method === "PUT") {
    const text = await request.text();
    await env.NOTES.put("notes", text);
    return json({ ok: true, chars: text.length });
  }
  return new Response("method not allowed", { status: 405, headers: cors() });
}

// Finance proxy → 42payments. The browser sends { path, method, body }; we attach the
// X-API-Key secret (never exposed to the browser) and forward to PAYMENTS_BASE + path.
// Upstream status/JSON passes straight through (incl. 401 bad-key, 409 not-connected) so the
// browser/agent can react. A network failure (app offline / tunnel down) → 503 {offline:true}.
async function handleFinance(request, env) {
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors() });
  if (!env.PAYMENTS_API_KEY) return json({ error: "Finance not configured — set the PAYMENTS_API_KEY secret on the Worker." }, 501);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  let path = typeof body.path === "string" ? body.path : "";
  // Only relative paths under the ext surface — no absolute URLs, no traversal.
  if (!path.startsWith("/") || path.includes("://") || path.includes("..")) return json({ error: "bad finance path" }, 400);
  const method = body.method === "POST" ? "POST" : "GET";
  let r;
  try {
    r = await fetch(PAYMENTS_BASE + path, {
      method,
      headers: { "X-API-Key": env.PAYMENTS_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
      body: method === "POST" ? JSON.stringify(body.body || {}) : undefined,
    });
  } catch {
    return json({ error: "finance tool offline — 42payments isn't reachable right now.", offline: true }, 503);
  }
  const text = await r.text();
  // Clean JSON passes through; a non-JSON body (e.g. an HTML error page) becomes one tidy line
  // instead of a wall of markup reaching the dashboard.
  try {
    return json(JSON.parse(text || "{}"), r.status);
  } catch {
    return json({ error: "42payments returned a non-JSON response (HTTP " + r.status + ") — it may be mid-setup or behind an error page.", code: "upstream_nonjson", upstream_status: r.status }, 502);
  }
}

// Credit-card payoff plan — a tiny JSON blob (strategy/target/monthly) the dashboard's
// debt card owns and edits. Stored in the NOTES KV under "ccplan" so it syncs across
// Q's devices. Gated upstream by authed() like everything else.
async function handleCCPlan(request, env) {
  if (!env.NOTES) return json({ error: "storage not configured" }, 501);
  if (request.method === "GET") {
    const v = await env.NOTES.get("ccplan");
    let plan = null; try { plan = v ? JSON.parse(v) : null; } catch { plan = null; }
    return json({ plan });
  }
  if (request.method === "PUT") {
    const t = await request.text();
    try { JSON.parse(t); } catch { return json({ error: "bad json" }, 400); }
    await env.NOTES.put("ccplan", t);
    return json({ ok: true });
  }
  return new Response("method not allowed", { status: 405, headers: cors() });
}

// Projects board — the dashboard's idea→shipped tracker. A JSON array of project
// records, stored in the NOTES KV under "projects" so it syncs across Q's devices.
// Gated upstream by authed() like everything else.
async function handleProjects(request, env) {
  if (!env.NOTES) return json({ error: "storage not configured" }, 501);
  if (request.method === "GET") {
    const v = await env.NOTES.get("projects");
    let projects = null; try { projects = v ? JSON.parse(v) : null; } catch { projects = null; }
    return json({ projects });
  }
  if (request.method === "PUT") {
    const t = await request.text();
    try { if (!Array.isArray(JSON.parse(t))) return json({ error: "expected a JSON array" }, 400); }
    catch { return json({ error: "bad json" }, 400); }
    await env.NOTES.put("projects", t);
    return json({ ok: true });
  }
  return new Response("method not allowed", { status: 405, headers: cors() });
}

// Tracker42 (Portal42 ticketing) proxy. The browser hits /tracker?action=…&since=…&limit=…&id=…;
// we attach the PORTAL42_TOKEN Bearer (never exposed to the browser) and forward to the Portal42
// API. Read-only actions only. Network failure → 503 {offline:true}; upstream status/JSON pass
// straight through (so 401 bad-token, 403 scope, 400 unknown-action reach the dashboard/agent).
const TRACKER_BASE = "https://tracker42.com/api/v1.php";
async function handleTracker(request, env) {
  if (!env.PORTAL42_TOKEN) return json({ error: "Tracker42 not configured — set the PORTAL42_TOKEN secret on the Worker.", code: "not_configured" }, 501);
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "ping";
  const READ = new Set(["ping", "notifications", "tickets", "ticket", "statuses", "ticket_events"]);
  const WRITE = new Set(["mark_read", "mark_all_read", "set_status", "add_comment", "create_ticket"]);
  if (!READ.has(action) && !WRITE.has(action)) return json({ success: false, error: "unknown action: " + action }, 400);
  const params = new URLSearchParams({ action });
  for (const k of ["since", "limit", "id", "offset", "status", "order", "ticket_id"]) { const v = url.searchParams.get(k); if (v != null) params.set(k, v); }
  const isWrite = WRITE.has(action);
  // Write actions (set_status / add_comment / create_ticket / mark_*) POST to the upstream;
  // forward the dashboard's JSON body through untouched so the token-side does the work.
  const init = { method: isWrite ? "POST" : "GET", headers: { Authorization: "Bearer " + env.PORTAL42_TOKEN, "Accept": "application/json" } };
  if (isWrite && request.method === "POST") {
    let fwd; try { fwd = await request.text(); } catch { fwd = ""; }
    if (fwd) { init.headers["Content-Type"] = "application/json"; init.body = fwd; }
  }
  let r;
  try {
    r = await fetch(TRACKER_BASE + "?" + params.toString(), init);
  } catch {
    return json({ offline: true, error: "Tracker42 isn't reachable right now." }, 503);
  }
  let text; try { text = await r.text(); } catch (e) { return json({ success: false, code: "upstream_read", error: "Couldn't read Tracker42's response (HTTP " + r.status + "): " + (e && e.message ? e.message : String(e)) }, 502); }
  // Forward clean JSON straight through. If the upstream returns non-JSON (e.g. an HTML error
  // page — which Tracker42 does when a token is present but the api_tokens table/migration isn't
  // in place), don't relay a wall of HTML: surface one actionable line.
  try {
    return json(JSON.parse(text || "{}"), r.status);
  } catch {
    return json({
      success: false,
      code: "upstream_nonjson",
      upstream_status: r.status,
      error: "Tracker42 returned a non-JSON response (HTTP " + r.status + ") — its API may not be fully set up yet. Run the api_tokens migration on Tracker42, then retry.",
    }, 502);
  }
}

async function handleChat(request, env) {
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors() });
  let body;
  try { body = await request.json(); } catch { return json({ error: { message: "bad json" } }, 400); }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // The dashboard's model picker sends body.model; fall back to the cheap default.
  const model = (typeof body.model === "string" && ALLOWED_MODELS.has(body.model)) ? body.model : DEFAULT_MODEL;

  // We stream, so timeouts aren't a concern; give the smart models headroom for thinking.
  const smart = SMART_MODELS.has(model);
  const payload = { model, max_tokens: smart ? 6000 : 1500, system: SYSTEM, tools: TOOLS, messages, stream: true };
  if (smart) {
    payload.thinking = { type: "adaptive" };       // Claude decides when/how much to think
    payload.output_config = { effort: "medium" };  // balance quality vs token spend
  }

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  // Upstream errors come back as JSON (not SSE) — surface them as JSON so the dashboard
  // can show the message. On success, pipe the SSE stream straight through to the browser.
  if (!r.ok) {
    let err;
    try { err = await r.json(); } catch { err = { error: { message: "upstream " + r.status } }; }
    return json(err, r.status);
  }
  return new Response(r.body, {
    status: 200,
    headers: { ...cors(), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

export default {
  async fetch(request, env) {
    // Wrap everything: an uncaught throw otherwise yields Cloudflare's default error page,
    // which has NO CORS headers — the browser then reports a misleading "access control checks"
    // failure instead of the real error. This guarantees a CORS-safe JSON error the dashboard
    // can read and show.
    try {
      if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
      if (!authed(request, env)) return json({ error: { message: "Locked — enter your dashboard passphrase.", code: "auth" } }, 401);
      const url = new URL(request.url);
      if (url.pathname === "/notes") return handleNotes(request, env);
      if (url.pathname === "/finance") return handleFinance(request, env);
      if (url.pathname === "/ccplan") return handleCCPlan(request, env);
      if (url.pathname === "/projects") return handleProjects(request, env);
      if (url.pathname === "/tracker") return handleTracker(request, env);
      return handleChat(request, env);
    } catch (e) {
      return json({ success: false, code: "worker_exception", error: "Worker error: " + (e && e.message ? e.message : String(e)) }, 500);
    }
  },
};
