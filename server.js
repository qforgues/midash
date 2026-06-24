/**
 * miDash chat backend — Raspberry Pi / Node version
 * --------------------------------------------------
 * Same job as worker.js, but runs on your own machine (e.g. the Pi you already
 * use for Discord). Zero dependencies — uses built-in fetch (Node 18+).
 *
 * Run:
 *   export ANTHROPIC_API_KEY=sk-ant-...      # keep this out of git
 *   export ALLOWED_ORIGIN=https://YOURNAME.github.io
 *   node server.js
 *
 * Then expose it (pick one):
 *   - Cloudflare Tunnel:  cloudflared tunnel --url http://localhost:8787
 *   - Or your existing reverse proxy / port forward (use HTTPS!)
 *
 * Put the public URL + "/chat" into CONFIG.chatEndpoint in index.html.
 */

const http = require("http");

const PORT = process.env.PORT || 8787;
const KEY = process.env.ANTHROPIC_API_KEY;
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MODEL = "claude-sonnet-4-6";
const SYSTEM = "You are the personal assistant embedded in Q's dashboard (miDash). Be concise and helpful.";

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method !== "POST" || !req.url.startsWith("/chat")) {
    res.writeHead(404, cors); return res.end("not found");
  }

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    try {
      const { messages = [] } = JSON.parse(raw || "{}");
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, messages }),
      });
      const data = await r.json();
      const reply = data?.content?.[0]?.text || data?.error?.message || "(no reply)";
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ reply }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
}).listen(PORT, () => console.log(`miDash chat backend on :${PORT}`));
