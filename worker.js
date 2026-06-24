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
const MODEL = "claude-sonnet-4-6";

const SYSTEM = `You are the assistant embedded in Q's personal dashboard (miDash).
You can read Q's Google Calendar (across ALL of his connected Google accounts and ALL
calendars) and read, reply to, trash, archive, and mark-read his Gmail, delete calendar
events, and read his Notes scratchpad — via the provided tools. Tools run in Q's browser
using his own Google logins. Be concise and friendly.

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
- reply_email, trash_email and delete_event pop a confirmation dialog on Q's screen, so
  just call the tool when asked — do NOT ask for permission again in text. If a tool
  returns cancelled:true, respect it and don't retry.
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
];

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors() } });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors() });

    let body;
    try { body = await request.json(); } catch { return json({ error: { message: "bad json" } }, 400); }
    const messages = Array.isArray(body.messages) ? body.messages : [];

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM, tools: TOOLS, messages }),
    });

    const data = await r.json();           // pass the full Anthropic response back
    return json(data, r.ok ? 200 : r.status);
  },
};
