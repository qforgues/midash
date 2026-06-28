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
- After acting, briefly confirm what you did. Draft replies in Q's voice: warm, brief, direct.`;

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
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    if (!authed(request, env)) return json({ error: { message: "Locked — enter your dashboard passphrase.", code: "auth" } }, 401);
    const url = new URL(request.url);
    if (url.pathname === "/notes") return handleNotes(request, env);
    return handleChat(request, env);
  },
};
