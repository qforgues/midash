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
You can read Q's Google Calendar and read, reply to, trash, archive, and mark-read
Q's Gmail, via the provided tools. Tools run in Q's browser using his own Google
login. Be concise and friendly.

Guidelines:
- When the user refers to "the latest email from X" or similar, first call
  search_emails to find the message id, then act on it.
- reply_email and trash_email pop a confirmation dialog on Q's screen, so just call
  the tool when asked — do NOT ask for permission again in text. If a tool returns
  cancelled:true, respect it and don't retry.
- After acting, briefly confirm what you did.
- For drafting replies, write in Q's voice: warm, brief, direct.`;

const TOOLS = [
  { name: "search_emails",
    description: "Search Gmail. Returns messages with id, from, subject, date, snippet. Use Gmail search syntax in 'query' (e.g. 'is:unread', 'from:sam newer_than:7d', 'category:promotions', 'subject:invoice').",
    input_schema: { type: "object", properties: { query: { type: "string" }, max: { type: "integer", description: "max results, default 5" } }, required: ["query"] } },
  { name: "get_email",
    description: "Get the full body and headers of one email by id.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "reply_email",
    description: "Reply to an email by id, in the same thread. Q confirms on screen before it sends.",
    input_schema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" } }, required: ["id", "body"] } },
  { name: "trash_email",
    description: "Move an email to Trash by id. Q confirms on screen.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "archive_email",
    description: "Archive an email (remove it from the inbox) by id.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "mark_read",
    description: "Mark an email as read by id.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "list_events",
    description: "List upcoming calendar events for the next N days (default 3).",
    input_schema: { type: "object", properties: { days: { type: "integer" } }, required: [] } },
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
