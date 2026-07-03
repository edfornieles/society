#!/bin/bash
# Keep the live site's Watercooler voice alive: expose local Pocket-TTS
# through a Cloudflare quick tunnel and point the Worker's POCKET_TTS_URL
# at it.
#
# HEALTH IS JUDGED THROUGH THE LIVE SITE ONLY. Never probe the tunnel URL
# from this Mac: trycloudflare hostnames are minted on the fly and local
# resolvers cache the initial NXDOMAIN, so a healthy fresh tunnel looks
# dead from here for minutes — an earlier watchdog probing directly kept
# "repairing" healthy tunnels and churned the URL in a loop. The Worker's
# view (does /api/tts return audio/wav?) is the only truth that matters.
#
# Usage: ./scripts/tts-tunnel.sh          (idempotent: exits if healthy)
# Prereqs: pocket-tts on :8123, cloudflared installed, wrangler logged in.
set -euo pipefail

PORT=8123
LOG=/tmp/cf_quick.log
LIVE_TTS="https://edfornieles.com/society/api/tts"

live_voice() {
  curl -s -o /dev/null -w "%{content_type}" --max-time 45 -X POST "$LIVE_TTS" \
    -H "Content-Type: application/json" -d '{"text":"voice health check"}' 2>/dev/null || true
}

if [ "$(live_voice)" = "audio/wav" ]; then
  echo "✅ already healthy — live site is speaking with the Watercooler voice"
  exit 0
fi

if ! curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/"; then
  echo "Pocket-TTS is not running on :$PORT — start it first." >&2
  exit 1
fi

# rotate the tunnel fresh so the log contains exactly one current URL
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

echo "$URL" | npx wrangler secret put POCKET_TTS_URL --name society

# wait for the WORKER to reach it (up to ~2min: secret version rollout +
# tunnel edge routing); do NOT probe $URL directly from this machine.
for i in $(seq 1 24); do
  sleep 5
  if [ "$(live_voice)" = "audio/wav" ]; then
    echo "✅ live site is speaking with the Watercooler voice (after $((i*5))s)"
    exit 0
  fi
done
echo "⚠️ live TTS still not Watercooler after 2min — check /tmp/cf_quick.log and rerun" >&2
exit 1
