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
