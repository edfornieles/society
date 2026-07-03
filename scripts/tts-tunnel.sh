#!/bin/bash
# Re-establish the live site's Watercooler voice after a Mac reboot/sleep.
#
# The deployed Worker reaches the local Pocket-TTS through a Cloudflare quick
# tunnel whose URL changes on every restart. This script starts (or restarts)
# the tunnel and points the Worker's POCKET_TTS_URL secret at the new URL.
#
# Usage: ./scripts/tts-tunnel.sh
# Prereqs: pocket-tts serving on :8123, cloudflared installed, wrangler logged in.
set -euo pipefail

PORT=8123
LOG=/tmp/cf_quick.log

if ! curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/"; then
  echo "Pocket-TTS is not running on :$PORT — start it first." >&2
  exit 1
fi

# restart tunnel fresh so the log contains exactly one current URL
pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null || true
sleep 1
(cloudflared tunnel --url "http://localhost:$PORT" > "$LOG" 2>&1 &)

URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "tunnel URL never appeared — see $LOG" >&2; exit 1; }
echo "tunnel: $URL"

# wait until the edge actually routes it, then verify TTS end-to-end
for _ in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$URL/" || true)
  [ "$code" = "200" ] && break
  sleep 2
done

echo "$URL" | npx wrangler secret put POCKET_TTS_URL --name society

sleep 5
ct=$(curl -s -o /dev/null -w "%{content_type}" --max-time 60 -X POST \
  "https://edfornieles.com/society/api/tts" \
  -H "Content-Type: application/json" -d '{"text":"Voice check."}')
if [ "$ct" = "audio/wav" ]; then
  echo "✅ live site is speaking with the Watercooler voice"
else
  echo "⚠️ live TTS returned $ct (fallback voice) — give it a minute and re-run the check:"
  echo "   curl -s -o /dev/null -w '%{content_type}\\n' -X POST https://edfornieles.com/society/api/tts -H 'Content-Type: application/json' -d '{\"text\":\"check\"}'"
fi
