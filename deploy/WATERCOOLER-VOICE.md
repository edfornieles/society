# Watercooler voice — permanent setup

The live site (edfornieles.com/society) plays the Kyutai Pocket-TTS
"Watercooler" voice. There is **no fallback** — Watercooler or silence.

## How it's wired
- `pocket-tts serve --port 8123` runs on this Mac (the voice engine).
- A **named** Cloudflare tunnel `society-tts` exposes it at the STABLE
  hostname **https://tts.edfornieles.com** (never rotates).
- The `society` Worker's `POCKET_TTS_URL` secret = `https://tts.edfornieles.com`.
- Both processes run under launchd (RunAtLoad + KeepAlive), so they
  auto-start on boot and auto-restart on crash. Plists are copied here for
  reference; the live ones live in `~/Library/LaunchAgents/`.

## Check status
    curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
      -X POST https://edfornieles.com/society/api/tts \
      -H "Content-Type: application/json" -d '{"text":"check"}'
    # want: 200 audio/wav

## Restart the voice stack
    launchctl kickstart -k gui/$(id -u)/com.edfornieles.pocket-tts
    launchctl kickstart -k gui/$(id -u)/com.edfornieles.society-tts-tunnel

## Tunnel facts
- tunnel name: society-tts   id: 5b3f7b9e-a6bd-4ded-89fd-ebfa0618363f
- config: ~/.cloudflared/config.yml  (ingress tts.edfornieles.com -> :8123)
- credentials: ~/.cloudflared/5b3f7b9e-....json  (keep secret; not in git)
