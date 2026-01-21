# Society — Realtime Voice Game (Next.js + OpenAI Realtime)

A real-time spoken improv worldbuilding game **Society**:

- Browser **WebRTC** mic → OpenAI **Realtime** speech-to-speech → browser audio out
- A structured **Society Bible** (JSON) that you control
- Guardrails: short turn format, canon tracking, recap, undo, image scene proposals
- Optional **image generation** with `gpt-image-1`

## 1) Setup

```bash
npm install
echo "OPENAI_API_KEY=your_key_here" > .env.local
npm run dev   # runs on http://127.0.0.1:3001
```

Open <http://127.0.0.1:3001>

## 2) What’s included

- `/app` UI:
  - Full-screen welcome scene with centered logo + intro prompt
  - Start/Pause/Stop realtime session
  - Live assistant transcript
  - Floating scene caption that updates with each image
  - Top nav: New Game / Saved / Rules / Settings
  - Settings: voice, playfulness, players, auto images, event log, summary, delete session
  - Saved sessions load into the same canvas (with optional recap)

- `/app/api/realtime-session`:
  - Creates a Realtime WebRTC call using `POST https://api.openai.com/v1/realtime/calls`
  - Sends back the SDP answer so the browser can complete the peer connection

- `/app/api/image-generate`:
  - Generates a scene image with `gpt-image-1` and returns base64
- `RULES.md`:
  - Always-on rules for players and the AI; rendered in the in-app Rules panel

## 3) Important notes

- The model voice must be chosen before the first audio response (can’t change afterwards).
- Realtime sessions are capped at ~60 minutes; you can reconnect and carry the Bible forward.
- Echo: keep headphones on if possible (prevents the model hearing itself).
- Sessions autosave (bible + images + summary) and are restored when reloading.
- Sessions are stored **locally in your browser** using **IndexedDB** (`DB: society`, store: `games`).

## 4) Welcome background

- Static welcome background lives at `public/welcome-society.png`.
- Regenerate it with `node scripts/generate_welcome_image.mjs`.

## 5) Verifying save/load

Quick manual check:

1. Start a session, say a core value (e.g., “sports cars”), and generate at least one image.
2. Press Stop → confirm you return to the welcome screen.
3. Click **Saved** and confirm the session appears with the core value as the title.
4. Load it → images and summary should be restored.

If sessions aren’t showing, verify IndexedDB has entries:

- Chrome: DevTools → Application → IndexedDB → `society` → `games`
- Safari: Develop → Show Web Inspector → Storage → IndexedDB

## 6) Docs referenced

- Realtime WebRTC guide: <https://platform.openai.com/docs/guides/realtime-webrtc>
- Realtime conversations/events: <https://platform.openai.com/docs/guides/realtime-conversations>
- Images API: <https://platform.openai.com/docs/api-reference/images>
