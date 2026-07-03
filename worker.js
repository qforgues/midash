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
  "claude-fable-5",     // Fable 5   (newest flagship)
]);
const DEFAULT_MODEL = "claude-haiku-4-5";
// Adaptive thinking + the effort parameter are supported on Sonnet 4.6 / Opus 4.8 / Fable 5
// but NOT on Haiku 4.5 (sending them to Haiku 400s). So we only enable them on the smart models.
const SMART_MODELS = new Set(["claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5"]);

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

Projects (the bigger picture): Q tracks projects on a board, in two types. SOFTWARE
(website/app) runs idea → validate → plan → build → test → ship → grow. PROPERTY (physical
builds & renovations on his two properties) runs idea → scope → design → source → build →
finish → done. Use list_projects to see them (each returns type, stage, progressPct, its
"next" action, and lastTouchedDays — high = neglected). His north star is "keep every project
moving, leave none behind", so for "what should I work on / what's stalling / how are my
projects or properties" call list_projects and steer him to the most neglected ones and their
next action. Use update_project to advance a stage or set the next action (e.g. "move La Palma
to ship", "move the kitchen reno to build") — always use that project type's stage words. Use
add_project (with type: "property" for a build/reno) to start tracking something new. These act
immediately (no confirm).

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
    description: "List Q's tracked projects, most-neglected-first. Two types: SOFTWARE (idea|validate|plan|build|test|ship|grow) and PROPERTY (physical builds/renos on his two properties: idea|scope|design|source|build|finish|done). Each item has name, type, stage, progressPct, next (the next action, may be null), lastTouchedDays (high = neglected), stale (boolean), url, repo. Use for 'what should I work on / what's stalling / how are my projects / properties'.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "update_project",
    description: "Update one of Q's tracked projects, matched by name (case-insensitive, partial ok). Set any of: stage, next (the single next action), notes. Use the stage vocabulary for THAT project's type — software: idea|validate|plan|build|test|ship|grow; property: idea|scope|design|source|build|finish|done. Touches last-updated so it stops looking neglected. Acts immediately — no confirmation.",
    input_schema: { type: "object", properties: { name: { type: "string" }, stage: { type: "string", enum: ["idea","validate","plan","build","test","ship","grow","scope","design","source","finish","done"] }, next: { type: "string" }, notes: { type: "string" } }, required: ["name"] } },
  { name: "add_project",
    description: "Add a NEW project to Q's tracker. Needs name. type is 'software' (default) or 'property' (a physical build/reno on one of his properties). Optional stage (default idea; use that type's vocabulary), next (next action), url (live site or listing/map link), repo (owner/repo — software only). Acts immediately — no confirmation.",
    input_schema: { type: "object", properties: { name: { type: "string" }, type: { type: "string", enum: ["software","property"] }, stage: { type: "string", enum: ["idea","validate","plan","build","test","ship","grow","scope","design","source","finish","done"] }, next: { type: "string" }, url: { type: "string" }, repo: { type: "string" } }, required: ["name"] } },

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

// Contact metadata — miDash-owned tags (business/personal), usage counts, and hidden flags,
// keyed by lowercased email. Google is the source of truth for the contacts themselves; this
// just layers Q's own data on top. Stored in NOTES KV as "contacts_meta". Gated by authed().
async function handleContactsMeta(request, env) {
  if (!env.NOTES) return json({ error: "storage not configured" }, 501);
  if (request.method === "GET") {
    const v = await env.NOTES.get("contacts_meta");
    let meta = null; try { meta = v ? JSON.parse(v) : null; } catch { meta = null; }
    return json({ meta });
  }
  if (request.method === "PUT") {
    const t = await request.text();
    try { JSON.parse(t); } catch { return json({ error: "bad json" }, 400); }
    await env.NOTES.put("contacts_meta", t);
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

// Discord bot heartbeat. The local bot POSTs here every minute; the dashboard GETs it to
// show a live green/red "Discord" light. The Worker stamps the receive time (its own clock),
// so the dashboard just checks freshness. Stored in the NOTES KV. Gated by authed().
async function handleDiscordStatus(request, env) {
  if (!env.NOTES) return json({ error: "storage not configured" }, 501);
  if (request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const rec = { online: true, tag: b && b.tag ? String(b.tag).slice(0, 64) : null, at: Date.now() };
    await env.NOTES.put("discord_status", JSON.stringify(rec));
    return json({ ok: true });
  }
  const v = await env.NOTES.get("discord_status");
  let status = null; try { status = v ? JSON.parse(v) : null; } catch {}
  return json({ status });
}

// Agent over external channels (Discord now, SMS/Twilio later) — CHAT-ONLY MVP, no tools.
// Takes { messages:[{role,content}] } or { message:"..." }, returns { reply, usage }.
// NON-streaming (a bot wants the whole reply). Gated by authed() like everything else.
// ---- Server-side tools for the Discord/SMS agent (no browser needed) ----
const AGENT_PIPELINES = {
  software: ["idea", "validate", "plan", "build", "test", "ship", "grow"],
  property: ["idea", "scope", "design", "source", "build", "finish", "done"],
};
const AGENT_PIPELINE = AGENT_PIPELINES.software;   // back-compat
function agentPipe(t) { return AGENT_PIPELINES[t] || AGENT_PIPELINES.software; }
function agentType(p) { return (p && AGENT_PIPELINES[p.type]) ? p.type : "software"; }
const AGENT_SYSTEM = `You are Q's personal assistant "Dash", reachable over Discord. Be concise, warm, and
direct — keep replies short enough to read comfortably in a chat app (a few sentences, use line breaks/lists sparingly).
You have TOOLS for Q's finances (42payments), his Portal42/Tracker42 tickets, his Projects board, and his Notes
scratchpad — use them to actually get things done, then confirm briefly what you did.
You do NOT have his email or calendar here (those need the miDash dashboard) — if he asks for those, say so plainly.
For anything OTHERS would see (a ticket status change, a ticket comment), briefly confirm with Q before doing it
unless he was already explicit. Reading is always fine to do immediately.`;
const AGENT_TOOLS = [
  { name: "read_notes", description: "Read Q's free-form Notes scratchpad.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "add_note", description: "Jot a line to the TOP of Q's Notes scratchpad.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "list_projects", description: "List Q's tracked projects (type, stage, next action, days since touched). Software and property (physical build/reno) projects each have their own stages.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "add_project", description: "Add a new project. name required. type: 'software' (default) or 'property'. Optional stage — software: idea|validate|plan|build|test|ship|grow; property: idea|scope|design|source|build|finish|done. Optional next, url, repo (software only).", input_schema: { type: "object", properties: { name: { type: "string" }, type: { type: "string", enum: ["software","property"] }, stage: { type: "string" }, next: { type: "string" }, url: { type: "string" }, repo: { type: "string" } }, required: ["name"] } },
  { name: "update_project", description: "Update a project by name (partial match ok): set stage and/or next action. Use that project type's stage vocabulary (software: idea…grow; property: idea|scope|design|source|build|finish|done).", input_schema: { type: "object", properties: { name: { type: "string" }, stage: { type: "string" }, next: { type: "string" }, notes: { type: "string" } }, required: ["name"] } },
  { name: "finance_summary", description: "Q's business finance rollup (revenue, outstanding, expenses, net) from 42payments.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "list_tracker_notifications", description: "List Q's Portal42 (Tracker42) notifications, newest first.", input_schema: { type: "object", properties: { limit: { type: "integer" } }, required: [] } },
  { name: "get_ticket", description: "Get a Portal42 ticket's details by numeric id.", input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "set_ticket_status", description: "Change a Portal42 ticket's status (e.g. current, code_review, released). A note is required for failed_beta/failed_live/released. Confirm with Q first.", input_schema: { type: "object", properties: { id: { type: "integer" }, status: { type: "string" }, note: { type: "string" } }, required: ["id", "status"] } },
  { name: "add_ticket_comment", description: "Add a comment/reply to a Portal42 ticket. Confirm with Q first.", input_schema: { type: "object", properties: { ticket_id: { type: "integer" }, comment: { type: "string" }, is_internal: { type: "boolean" } }, required: ["ticket_id", "comment"] } },
];
async function agentGetProjects(env) { try { const v = await env.NOTES.get("projects"); const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch { return []; } }
async function agentFinance(env, path) {
  if (!env.PAYMENTS_API_KEY) return { error: "finance not configured" };
  try { const r = await fetch(PAYMENTS_BASE + path, { headers: { "X-API-Key": env.PAYMENTS_API_KEY, "Accept": "application/json" } }); const t = await r.text(); try { return JSON.parse(t || "{}"); } catch { return { error: "finance returned non-JSON (app may be down)" }; } }
  catch { return { error: "42payments offline" }; }
}
async function agentTracker(env, action, params, body) {
  if (!env.PORTAL42_TOKEN) return { error: "tracker not configured" };
  const qs = new URLSearchParams({ action });
  if (params) for (const k in params) if (params[k] != null) qs.set(k, params[k]);
  const isWrite = ["set_status", "add_comment", "create_ticket", "mark_read", "mark_all_read"].includes(action);
  const init = { method: isWrite ? "POST" : "GET", headers: { Authorization: "Bearer " + env.PORTAL42_TOKEN, "Accept": "application/json" } };
  if (isWrite && body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  try { const r = await fetch(TRACKER_BASE + "?" + qs.toString(), init); const t = await r.text(); try { return JSON.parse(t || "{}"); } catch { return { error: "tracker returned non-JSON" }; } }
  catch { return { error: "Tracker42 offline" }; }
}
async function runAgentTool(name, a, env) {
  a = a || {};
  try {
    switch (name) {
      case "read_notes": { const n = await env.NOTES.get("notes"); return { notes: (n || "").slice(0, 4000) }; }
      case "add_note": { if (!a.text) return { error: "need text" }; const cur = (await env.NOTES.get("notes")) || ""; const next = "- " + String(a.text) + "  · " + new Date().toISOString().slice(0, 10) + "\n" + cur; await env.NOTES.put("notes", next.slice(0, 20000)); return { added: true }; }
      case "list_projects": { const ps = await agentGetProjects(env); return { projects: ps.map(p => { const t = agentType(p); return { name: p.name, type: t, stage: agentPipe(t)[p.stage] || "idea", next: p.next || null, lastTouchedDays: p.updated ? Math.round((Date.now() - p.updated) / 86400000) : null, url: p.url || null }; }) }; }
      case "add_project": { if (!a.name) return { error: "need name" }; const ps = await agentGetProjects(env); const t = AGENT_PIPELINES[a.type] ? a.type : "software"; const si = a.stage ? agentPipe(t).indexOf(String(a.stage).toLowerCase()) : 0; const np = { id: "p_" + Date.now().toString(36), name: String(a.name), type: t, url: String(a.url || ""), repo: t === "software" ? String(a.repo || "") : "", stage: si >= 0 ? si : 0, next: String(a.next || ""), notes: "", updated: Date.now(), pinned: false, order: (ps.reduce((m, p) => Math.max(m, p.order || 0), 0) + 1) }; ps.push(np); await env.NOTES.put("projects", JSON.stringify(ps)); return { added: true, name: np.name, type: t }; }
      case "update_project": { if (!a.name) return { error: "need name" }; const ps = await agentGetProjects(env); const q = String(a.name).toLowerCase(); const p = ps.find(x => x.name.toLowerCase() === q) || ps.find(x => x.name.toLowerCase().includes(q)); if (!p) return { error: "no project matching " + a.name }; const pipe = agentPipe(agentType(p)); if (a.stage) { const si = pipe.indexOf(String(a.stage).toLowerCase()); if (si < 0) return { error: "bad stage for this " + agentType(p) + " project; use one of " + pipe.join(", ") }; p.stage = si; } if (a.next != null) p.next = String(a.next); p.updated = Date.now(); await env.NOTES.put("projects", JSON.stringify(ps)); return { updated: true, name: p.name, type: agentType(p), stage: pipe[p.stage] }; }
      case "finance_summary": return await agentFinance(env, "/summary");
      case "list_tracker_notifications": { const d = await agentTracker(env, "notifications", { since: 0, order: "desc", limit: a.limit || 10 }); if (d && d.success === false) return { error: d.error }; return { notifications: (d && d.data) || [], meta: (d && d.meta) || {} }; }
      case "get_ticket": { if (a.id == null) return { error: "need id" }; const d = await agentTracker(env, "ticket", { id: a.id }); return (d && d.data) || d; }
      case "set_ticket_status": { if (a.id == null || !a.status) return { error: "need id and status" }; return await agentTracker(env, "set_status", null, { id: a.id, status: a.status, note: a.note || undefined }); }
      case "add_ticket_comment": { if (a.ticket_id == null || !a.comment) return { error: "need ticket_id and comment" }; return await agentTracker(env, "add_comment", null, { ticket_id: a.ticket_id, comment: a.comment, is_internal: a.is_internal }); }
      default: return { error: "unknown tool " + name };
    }
  } catch (e) { return { error: String(e && e.message || e) }; }
}
async function handleAgent(request, env) {
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors() });
  let body;
  try { body = await request.json(); } catch { return json({ error: { message: "bad json" } }, 400); }
  let msgs = Array.isArray(body.messages) ? body.messages.slice()
    : (body.message != null ? [{ role: "user", content: String(body.message) }] : []);
  if (!msgs.length) return json({ error: { message: "no message" } }, 400);
  const model = (typeof body.model === "string" && ALLOWED_MODELS.has(body.model)) ? body.model : DEFAULT_MODEL;
  let usage = null;
  for (let round = 0; round < 6; round++) {   // up to 6 tool rounds, then answer
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1400, system: AGENT_SYSTEM, tools: AGENT_TOOLS, messages: msgs }),
    });
    if (!r.ok) { let e; try { e = await r.json(); } catch { e = { error: { message: "upstream " + r.status } }; } return json(e, r.status); }
    const data = await r.json();
    usage = data.usage || usage;
    const toolUses = (data.content || []).filter(b => b.type === "tool_use");
    if (!toolUses.length) {
      const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      return json({ reply, usage });
    }
    msgs.push({ role: "assistant", content: data.content });
    const results = [];
    for (const tu of toolUses) {
      const out = await runAgentTool(tu.name, tu.input, env);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 8000) });
    }
    msgs.push({ role: "user", content: results });
  }
  return json({ reply: "I did a few steps but ran out of room — can you narrow it down a bit?", usage });
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
      if (url.pathname === "/contacts-meta") return handleContactsMeta(request, env);
      if (url.pathname === "/tracker") return handleTracker(request, env);
      if (url.pathname === "/agent") return handleAgent(request, env);
      if (url.pathname === "/discord-status") return handleDiscordStatus(request, env);
      return handleChat(request, env);
    } catch (e) {
      return json({ success: false, code: "worker_exception", error: "Worker error: " + (e && e.message ? e.message : String(e)) }, 500);
    }
  },
};
