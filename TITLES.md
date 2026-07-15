# TITLES × Society / LIFE — image-generation integration notes

For Paul & Derrick. This describes exactly where TITLES plugs into our games,
what the current pipeline sends and expects, and the smallest contract that
would let us swap TITLES in as the image provider.

## The two games

- **Society** (this repo, public): spoken improv worldbuilding — players
  invent a fictional society by voice; the game illustrates it as they play.
  Live at https://edfornieles.com/society
- **LIFE** (`edfornieles/life`, private — ask Ed for access): same engine,
  inverted — one human life simulated birth-to-death; images illustrate life
  moments and need a **visually consistent recurring character who ages**.

Both run as Next.js apps on Cloudflare Workers (OpenNext). Images are
generated **server-side** in an API route — not from the chat client — so the
integration point is a server-to-server call.

## Where images happen (the seam)

`app/api/image-scene/route.ts` — one route, two steps:

1. **Scene proposal** (fast LLM call): turns the game's canon + the latest
   exchange into `{ title, caption, seedFacts, prompt, negativePrompt,
   styleGuide }`. You don't need to touch this.
2. **Image generation** (the seam): the assembled `fullPrompt` +
   `combinedNegative` go to a provider. Today that's either:
   - OpenAI `gpt-image-1-mini` (default in production), or
   - a local ComfyUI pipeline (`lib/comfyImage.ts`), selected by
     `IMAGE_PROVIDER=comfyui` — see `comfyEnabled()` in the route.

   A TITLES provider would be a third branch behind `IMAGE_PROVIDER=titles`,
   ~30 lines, mirroring the ComfyUI one.

## The provider contract we need

The smallest thing that works for us:

```
request:  { prompt: string,            // ~500-2000 chars, includes a style guide
            negativePrompt?: string,   // things to avoid
            width: 1536, height: 1024 } // 3:2 landscape (full-viewport backdrop)
response: PNG/JPEG bytes (or a URL we can fetch server-side)
```

- **Auth**: any header-based secret works (we bake env vars into the Worker).
  OAuth-per-user does NOT fit this path — the Worker calls you, not the player.
- **Latency**: our current generation step runs 20-50s and the game tolerates
  it (images arrive async while play continues). Anything ≤60s is fine.
- **Volume**: modest — one image every 1-3 conversation turns per active
  player; think hundreds/day, not thousands/hour.

### About the MCP (`https://titles.xyz/mcp`)

Added to Ed's Claude Code per Paul's instructions
(`claude mcp add --transport http titles https://titles.xyz/mcp`) — pending
Ed completing the TITLES sign-in, after which we'll test-run generations from
chat and report back. **But note**: the MCP path authenticates a person in a
chat client; the game needs the server-to-server contract above. If the real
API is a way off, the proof-of-concept "fake" Derrick mentioned could simply
be: an HTTP endpoint that wraps whatever the MCP's generate tool calls
internally, with a static bearer token. That's enough for Somerset House.

## What the prompts look like

Real example of a `fullPrompt` our route assembles (Society, a "fashion"
world):

```
STYLE GUIDE (keep consistent): 64-bit retro pixel art (late PS1/N64-era).
Crisp pixels with richer detail, broader palette, subtle dithering, strong
silhouettes, readable shapes. Clean contemporary cinematic framing...

CANON SEEDS (must reflect):
- Fashion influences social hierarchy and relationships within the society.
- Individuals are judged and valued based on their fashion choices.

A vibrant street scene illustrating individuals displaying intricate
outfits, each signifying their social standing...

PERIOD/SETTING — DEFAULT TO THE PRESENT DAY or a near-future version...

Avoid: text, logos, photorealism, smooth gradients, gore, medieval setting,
victorian street, gas lamps...
```

The style guide is per-session-stable (visual consistency across a
playthrough). For LIFE we additionally need the **same character recognisable
across their whole life while aging** — if TITLES supports named/consistent
subjects (the "named artists, found by vibe" framing suggests identity is
central to your stack), that's the capability we're most excited about.

## Files worth reading

| File | What it shows |
|---|---|
| `app/api/image-scene/route.ts` | The full pipeline + the provider seam |
| `lib/comfyImage.ts` | What a provider implementation looks like |
| `lib/prompts.ts` (`imageSceneProposalPrompt`, `bibleAnchorContextForImages`, `signatureSubjects`) | How prompts are grounded in game canon |
| `app/api/media/[...key]/route.ts` + `lib/serverStorage.ts` | Where generated images land (R2) and how they're served |

## Contact / next steps

1. Ed completes the TITLES MCP sign-in → we test generations from chat and
   send you results.
2. You tell us the endpoint shape (or we adapt to whatever the PoC wrapper
   exposes) → we ship `IMAGE_PROVIDER=titles` behind the existing switch.
3. For LIFE: a short conversation about consistent-character support.

---

## Test-run findings (2026-07-14, verified live via Claude Code MCP)

**It works end-to-end.** Connected, authenticated, generated. Key facts:

- **48 tools**; the two that matter for us: `titles_generate_image`
  (one-call text-to-image — resolves operator + signs automatically) and
  `titles_run_execution` (any operator: edit/upscale/blend/video), plus
  `titles_await_execution` to block until done.
- **Timing**: 38s wall end-to-end; ~14s of actual render. Comfortably inside
  our tolerance.
- **Cost transparency is excellent**: the execution returned a quote —
  `$0.052 = compute 0.040 + titles_fee 0.006 + artist royalty 0.006`.
- **Output**: one execution returned 2 sibling images, 1024×576 PNG (16:9
  accepted as an aspect preset). We'd want 3:2 (or 16:9 is fine).
- On-chain provenance per output (tx_hash + node hashes) — nice for the
  artist-royalty story.

**Two integration blockers to solve together:**

1. **Asset URLs are signed, expire in ~40 min, and 403 outside the
   browser.** Our pipeline needs to fetch the bytes server-side once and
   store them in our R2 (players view them for the life of a saved game).
   We need either: asset URLs fetchable with the API/MCP bearer token, a
   `download` tool that returns bytes, or longer-lived signed URLs.
2. **Setup bug — the docs URL breaks Claude Code**: the connect page and
   email say `https://titles.xyz/mcp`, but the OAuth metadata declares the
   protected resource as `https://mcp.titles.xyz/mcp`. Spec-compliant
   clients validate that match and abort before the sign-in ever opens
   (error: "Protected resource https://mcp.titles.xyz/mcp does not match
   expected https://titles.xyz/mcp"). Connecting directly to
   `https://mcp.titles.xyz/mcp` works. Fix the metadata or the docs.

**Style findings** (matters for Society): the catalog currently has no true
pixel-art model, and a chosen artist model's trained look dominates the
prompt's style instructions (our test asked for 64-bit pixel art + bold
daylight color; the artist model returned its native low-poly night-time
look). For Society's fixed pixel-art style we'd use a generic base
architecture (no `model_id`); the genuinely exciting creative option is the
inverse: let each society/life adopt a NAMED TITLES ARTIST as its visual
identity — which is exactly what your named-artist system is for.

## Baseline test for the custom style model (2026-07-15)

Decision: **v1 ships in Society's existing 16-bit house style.** We've curated
a training set of 87 style-consistent in-game images (JPEG q92 + manifest CSV
with per-image titles/captions) — Ed is sending it to Paul/Derrick for
training. To scope what the trained model must fix, we ran the same real
Society prompt (dog-society Covenant Circle scene, full style guide) two ways
on one canvas: https://www.titles.xyz/create/9b122112-e205-4123-844f-8890286f96cb

1. **`model_id` omitted** → NOTE: this does NOT fall back to a generic base;
   TITLES auto-fits an artist model from the prompt (it picked Noisebits,
   royalty to its creator). Result: convincing pixel-art *style*, but the
   *content* collapsed to generic streets — no dogs, no fountain, no crowd.
2. **`model_id: "flux-lora"` (true generic base)** → the inverse: excellent
   content adherence (canine citizens ringing the fountain, stalls, banners,
   humans queueing at the edge) but zero pixel art — smooth flat illustration
   despite the explicit style guide.

So the two failure modes split cleanly: style-without-content vs
content-without-style. A LoRA trained on our 87 images over the flux base
should close the gap — flux's prompt adherence + the trained house look.
That's the ask. (Also: catalog re-checked 2026-07-15 — still no true
pixel-art model among the 31 hits for pixel/retro/16-bit.)
