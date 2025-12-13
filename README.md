# Society — Realtime Voice Starter (Next.js + OpenAI Realtime)

A minimal, Cursor-friendly starter for your spoken improv worldbuilding game **Society**:

- Browser **WebRTC** mic → OpenAI **Realtime** speech-to-speech → browser audio out
- A structured **Society Bible** (JSON) that you control
- Guardrails: short turn format, canon tracking, recap, undo, image scene proposals
- Optional **image generation** with `gpt-image-1`

## 1) Setup

```bash
npm install
cp .env.example .env.local
# add your OPENAI_API_KEY to .env.local
npm run dev   # runs on http://127.0.0.1:3001
```

Open <http://127.0.0.1:3001>

## 2) What’s included

- `/app` UI:
  - Start/stop realtime session
  - Live event log + transcript
  - Society Bible panel (canon + threads + changelog)
  - Buttons: Recap / Undo / Generate Image

- `/app/api/realtime-session`:
  - Creates a Realtime WebRTC call using `POST https://api.openai.com/v1/realtime/calls`
  - Sends back the SDP answer so the browser can complete the peer connection

- `/app/api/image-generate`:
  - Generates an image with `gpt-image-1` and returns base64
- `RULES.md`:
  - Always-on rules for players and the AI; rendered in the in-app Rules panel

## 3) Important notes

- The model voice must be chosen before the first audio response (can’t change afterwards).
- Realtime sessions are capped at ~60 minutes; you can reconnect and carry the Bible forward.
- Echo: keep headphones on if possible (prevents the model hearing itself).

## 4) Docs referenced

- Realtime WebRTC guide: <https://platform.openai.com/docs/guides/realtime-webrtc>
- Realtime conversations/events: <https://platform.openai.com/docs/guides/realtime-conversations>
- Images API: <https://platform.openai.com/docs/api-reference/images>
