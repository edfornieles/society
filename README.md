# Society — Realtime Voice Game (Next.js + OpenAI Realtime)

A real-time spoken improv worldbuilding game **Society**:

- Browser **WebRTC** mic → OpenAI **Realtime** speech-to-speech → browser audio out
- A structured **Society Bible** (JSON) that you control
- Guardrails: short turn format, canon tracking, recap, undo, image scene proposals
- Optional **image generation** with `gpt-image-1`

---

## Game flow

### Starting a new game

1. Press **Start** (or "Press Start to begin" on the welcome screen).
2. The AI greets the player and asks:
   > *"What's the most important thing in this society? Everything else will follow from it."*
   - **1a. Player asks for rules first** → the AI gives a brief explanation (yes-and per turn, one concrete fact, Mirror → Extend → Prompt format) and then asks the same question.
   - **1b. Player answers directly** → whatever they say becomes the society's core value and the game begins immediately.
3. Once the core value is set:
   - The session **auto-saves**, using the core value as the session title (e.g. *"Honor"*, *"Surveillance"*, *"Art"*).
   - The display text updates to *"THE MOST IMPORTANT THING IN THIS SOCIETY IS [their answer]"*.
   - The **first scene image begins generating** in the background.

### During gameplay

Each turn follows a rhythm:

- **Player speaks** — one yes-and statement: a fact, a consequence, a tiny vignette.
- **AI responds** — always: Mirror (echoes back in one sentence) → Extend (adds one concrete consequence in daily life) → Prompt (asks one question with 2–3 options to steer the next turn).
- The **Society Bible** (canon) updates silently after each AI turn, tracking: core values, institutions, status markers, daily life, open threads, and contradictions.
- A new **scene image auto-generates** every few turns (configurable in Settings).
- The **session autosaves** periodically in the background.

The AI actively rotates across the society's domains over a long session — values, kinship, law, economy, architecture, art, foreign relations, and more — so the world grows wide rather than deep in one area.

### Ending a session

- Press **Stop** at any time. The session saves and the welcome screen returns.
- Alternatively, say *"let's wrap up"* or similar — the AI will deliver a final vignette and a recap before you stop.
- Sessions are stored **as files on disk** (see [Where sessions are saved](#where-sessions-are-saved)) and persist across page reloads.

### Pausing

- Press **Pause** to mute your mic without ending the session. The AI will not respond while paused.
- Press **Resume** (or **Pause** again) to continue.

---

## Loading a saved game

1. Click **Saved** in the top nav. A list of past sessions appears, each named after its core value.
2. Click a session to load it — the Society Bible, images, and summary are restored.
3. A prompt appears asking whether to start with a **Recap** (the AI narrates what was built, with a slideshow of the session's images) or to **Continue** directly from where you left off.
4. Press **Play** (or **Start**) to reconnect. The AI welcomes you back and picks up from the existing canon.

---

## Starting a new game mid-session

- Click **New Game** in the top nav, or click the **Society logo** in the top-left corner.
- This clears the current session from the canvas (it stays saved) and returns to the welcome screen ready for a fresh start.

---

## Settings (accessible any time via the Settings button)

| Setting | Description |
|---|---|
| Voice | Choose the AI's voice (Marin, Alloy, Verse, Aria, Ember) |
| Playfulness | Dial the AI's tone from dry/serious (0) to playful/creative (3) |
| Auto images | Toggle automatic image generation on/off |
| Images every N turns | How often a new scene image generates (default: every turn) |
| Event log | Shows raw realtime events — useful for debugging |
| Delete session | Permanently removes the current session and its images from disk |

> **Note:** Voice must be chosen before pressing Start — it cannot be changed once a session is live.

---

## Where sessions are saved

By default (local dev), sessions are stored as files on the server, not in the browser:

| Path | Contents |
|---|---|
| `data/sessions/{id}.json` | Full session record: bible, canon, open threads, image metadata |
| `data/sessions/{id}.md` | Human-readable markdown transcript of the session (auto-generated on every save) |
| `public/game-images/{id}/{timestamp}.png` | Scene images generated during the session |

Both `data/sessions/` and `public/game-images/` are git-ignored.

### R2-backed storage (for cloud deploys)

If these env vars are set, sessions + images are stored in Cloudflare R2 instead of local disk:

```bash
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=society-canyon
R2_PUBLIC_BASE_URL=https://pub-<hash>.r2.dev
```

R2 key layout used by the app:

| R2 Key | Contents |
|---|---|
| `sessions/{id}.json` | Full session record |
| `sessions/{id}.md` | Human-readable markdown session transcript |
| `game-images/{id}/{timestamp}.png` | Generated scene images |

---

## 1) Setup

```bash
npm install
echo "OPENAI_API_KEY=your_key_here" > .env.local
npm run dev   # runs on http://127.0.0.1:3003 (redirects to /society_canyon)
```

Open **http://127.0.0.1:3003/society_canyon** (or `/`, which redirects there).

## 2) What's included

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

- `/app/api/image-scene`:
  - Uses `gpt-4o-mini` to generate a canon-consistent scene proposal
  - Generates the image with `gpt-image-1`
  - Saves PNG to `public/game-images/{sessionId}/{timestamp}.png` (local) or `game-images/{sessionId}/{timestamp}.png` in R2 (cloud)

- `/app/api/bible-update`:
  - Out-of-band canon extraction after each AI turn using `gpt-4o-mini`

- `/app/api/sessions` and `/app/api/sessions/[id]`:
  - Session persistence (local files by default, automatic R2 mode when R2 env vars exist)

- `RULES.md`:
  - Always-on rules for players and the AI; rendered in the in-app Rules panel

## 3) Important notes

- The model voice must be chosen before the first audio response (can't change afterwards).
- Realtime sessions are capped at ~60 minutes; you can reconnect and carry the Bible forward.
- Echo: keep headphones on if possible (prevents the model hearing itself).
- Sessions autosave (bible + images + summary) after every meaningful change.
- Language: the AI always responds in English. The transcription model is set to `language: "en"`.

## 4) Welcome background

- Static welcome background lives at `public/welcome-society.png`.
- Regenerate it with `node scripts/generate_welcome_image.mjs`.

## 5) Verifying save/load

Quick manual check:

1. Start a session, say a core value (e.g., "art"), and generate at least one image.
2. Press Stop → confirm you return to the welcome screen.
3. Click **Saved** and confirm the session appears with the core value as the title.
4. Load it → images and summary should be restored.
5. Local mode: check `data/sessions/` and `public/game-images/{id}/`.
6. R2 mode: check your bucket for `sessions/{id}.json`, `sessions/{id}.md`, and `game-images/{id}/...`.

## 6) Sharing for testing

Quickest way to let someone test the running app:

```bash
npm run build && npm run start                      # boots on http://127.0.0.1:3003
ngrok http --host-header=rewrite 127.0.0.1:3003     # in a second terminal
```

Share the `https://*.ngrok-free.app` URL ngrok prints. Mic permissions require `https://`, which ngrok provides for free. Sessions and images persist on _your_ machine while the tunnel is open.

For a longer-lived public URL, deploy to Cloudflare + R2 and map your custom domain path (e.g. `edfornieles.com/society`).

## 7) Cheapest cloud setup (Cloudflare + R2)

1. Create an R2 bucket (e.g. `society-canyon`) and enable a public bucket URL or custom domain.
2. Add these project env vars in Cloudflare Pages:
   - `OPENAI_API_KEY`
   - `R2_ENDPOINT`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET`
   - `R2_PUBLIC_BASE_URL`
3. Deploy the Next.js app to Cloudflare Pages.
4. In Cloudflare, route `edfornieles.com/society*` to this Pages project (Transform Rule / Worker / Pages project route).
5. Set app route to `/society_canyon` (already done); use a rule to rewrite `/society` -> `/society_canyon`.

## 8) Docs referenced

- Realtime WebRTC guide: <https://platform.openai.com/docs/guides/realtime-webrtc>
- Realtime conversations/events: <https://platform.openai.com/docs/guides/realtime-conversations>
- Images API: <https://platform.openai.com/docs/api-reference/images>
