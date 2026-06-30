#!/usr/bin/env bash
# One-shot Tracker42 hookup: checks your token, saves it to the Worker, and
# prints the sample data Claude needs to build the ticket card.
#
# Run it in your NORMAL Terminal (so your token stays private):
#   bash scripts/setup-tracker.sh
#
# Do the two admin steps FIRST (run the migration + generate the token in
# Portal42 admin). Then run this and paste the token when asked.

set -euo pipefail
cd "$(dirname "$0")/.."

API="https://tracker42.com/api/v1.php"
WRANGLER="wrangler"; command -v wrangler >/dev/null 2>&1 || WRANGLER="npx wrangler"

echo "──────────────────────────────────────────────"
echo " Tracker42 → miDash setup"
echo "──────────────────────────────────────────────"
read -rsp "Paste your Tracker42 token, then press Enter: " TOKEN
echo
[ -n "${TOKEN:-}" ] || { echo "❌ No token entered. Run the script again."; exit 1; }

echo
echo "→ Step 1/3: checking the token against Tracker42…"
PING="$(curl -s -H "Authorization: Bearer $TOKEN" "$API?action=ping")"
case "$PING" in
  *'"pong":true'*|*'"success":true'*)
    echo "   ✅ Token works." ;;
  *"not initialised"*|*"migration"*)
    echo "   ⚠️  Token reached Tracker42, but the migration hasn't been run yet."
    echo "       Portal42 Admin → Migrations → run migration_api_tokens.sql, then re-run this."
    echo "       (raw: $PING)"; exit 1 ;;
  *)
    echo "   ❌ Tracker42 didn't accept the token. Raw response:"
    echo "       $PING"; exit 1 ;;
esac

echo
echo "→ Step 2/3: saving the token to the Worker (Cloudflare)…"
printf '%s' "$TOKEN" | $WRANGLER secret put PORTAL42_TOKEN
echo "   ✅ Saved."

echo
echo "→ Step 3/3: grabbing real sample data for Claude…"
echo
echo "================ COPY EVERYTHING BELOW TO CLAUDE ================"
echo "--- ping ---";          curl -s -H "Authorization: Bearer $TOKEN" "$API?action=ping"; echo
echo "--- notifications ---"; curl -s -H "Authorization: Bearer $TOKEN" "$API?action=notifications&since=0&order=asc&limit=1"; echo
echo "--- statuses ---";      curl -s -H "Authorization: Bearer $TOKEN" "$API?action=statuses"; echo
echo "================ COPY EVERYTHING ABOVE TO CLAUDE ================"
echo
echo "🎉 Done. Open miDash, hit ↻ refresh on the Portal42 Tickets card — it should go green."
echo "   (The sample output above contains your name/scopes, NOT your token — safe to paste.)"
