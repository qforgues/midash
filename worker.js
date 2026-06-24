/**
 * miDash chat backend — Cloudflare Worker
 * --------------------------------------------------
 * Holds your Anthropic API key as a secret and proxies the dashboard's
 * chat widget to the Anthropic API. The key NEVER reaches the browser.
 *
 * Deploy (free tier is plenty):
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler deploy worker.js --name midash-chat
 *   3. wrangler secret put ANTHROPIC_API_KEY   (paste your key when prompted)
 *   4. Put the resulting https://midash-chat.<you>.workers.dev/ URL into
 *      CONFIG.chatEndpoint in index.html
 *
 * Lock it down: set ALLOWED_ORIGIN to your Pages URL so only your site can call it.
 */

const ALLOWED_ORIGIN = "*"; // e.g. "https://YOURNAME.github.io"
const MODEL = "claude-sonnet-4-6";
const SYSTEM = "You are the personal assistant embedded in Q's dashboard (miDash). Be concise and helpful. You can answer questions, draft text, and explain things. If asked to perform an action you cannot do from here, say so and suggest the best next step.";

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors() });

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const messages = Array.isArray(body.messages) ? body.messages : [];

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, messages }),
    });

    const data = await r.json();
    const reply = data?.content?.[0]?.text || data?.error?.message || "(no reply)";
    return json({ reply });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}
