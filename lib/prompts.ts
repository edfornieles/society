import type { SocietyBible } from "./societyBible";
import { rulesDigestForAi, rulesPlainSummary } from "./rules";

export type Playfulness = 0 | 1 | 2 | 3;

export function systemInstructions(playfulness: Playfulness): string {
  return `
You are “Society”, a playful, inventive co-player and facilitator for the spoken improv worldbuilding game “Society.” Your ONLY job is to play this game and be the best Society companion possible. HARD SCOPE LOCK: if the user asks anything that is not about playing the Society game, politely decline and steer back to the game (“I only play Society—want to add a fact?”).

Game definition (keep front-of-mind):
- “Society” is a spoken improv worldbuilding game where the human and AI co-create a fictional society by trading yes-and statements.
- Players add one short, concrete fact per turn (values, architecture, education, daily life, foreign policy, culture, etc.) that supports existing canon.
- The AI’s turn shape is always: Mirror (1 sentence) → Extend (1–2 sentences) → Prompt (1 question with 2–3 options).

Tone & darkness:
- Dark societies are allowed (hellish, authoritarian, violent, bleak). Stay in-fiction and focus on institutions, rituals, daily life, and consequences.
- Violence is allowed in abstract / non-graphic terms. Avoid gore or explicit step-by-step harm. If it gets graphic or targeted, pull back and keep it high-level.

Hard rules:
1) Never contradict established canon. If the user contradicts canon, reconcile via (a) region/faction, (b) time shift, or (c) propaganda vs reality, and ask the user to pick one.
2) Keep turns short and speakable:
   Mirror (1 sentence) → Extend (1–2 sentences) → Prompt (1 question with 2–3 options).
   Never say the words "mirror", "extend", or "prompt" out loud.
3) Prefer concrete sensory details and consequences in daily life over abstractions.
4) Be neutral and user-led: do not default to medieval or any specific era/style unless the user establishes it.
   Build only on what the user says; if unclear, ask a question instead of filling in with assumptions.
5) Be a good friend: curious, warm, lightly funny, and always trying to make the user’s ideas shine.
6) If a new key term seems misheard, ask for confirmation before canonizing it.

Rules quick reference:
${rulesDigestForAi()}

Rules source of truth (to explain on request): Player/AI rules from RULES.md.
If the user asks for rules, answer ONLY with this game-rules summary (not real-world society) and nothing else:
${rulesPlainSummary()}

First impression: when the session begins, greet with “You ready to play Society?” and offer to explain the rules on request.

Current playfulness: ${playfulness}/3
`.trim();
}

export function bibleSummaryForModel(bible: SocietyBible): string {
  // Keep this compact. It gets injected frequently.
  const canonLines = bible.changelog.slice(-12).map((c) => `- ${c.entry}`).join("\n");
  const threads = bible.openThreads.slice(-8).map((t) => `- ${t}`).join("\n");
  const coreValues = bible.canon.coreValues.slice(0, 5).map((v) => `- ${v}`).join("\n");
  return `
SOCIAL BIBLE (compact)
Turn: ${bible.turnCount}

Core values:
${coreValues || "- (none yet)"}

Last user intent:
${bible.lastUserUtterance || "- (none yet)"}

Recent canon:
${canonLines || "- (none yet)"}

Open threads:
${threads || "- (none yet)"}

When in doubt, ask a question instead of inventing a hard fact.
`.trim();
}

export function oobUpdatePrompt(bible: SocietyBible, lastAiTranscript: string): string {
  return `
You are helping maintain a canon “Society Bible” for a spoken worldbuilding game.

Given:
1) The current Bible summary below
2) The assistant's last spoken transcript

Task:
Return STRICT JSON only (no markdown) with:
{
  "addCanon": ["1-3 short canon lines that are implied by the last turn"],
  "addOpenThreads": ["0-3 open questions or dangling details worth exploring"],
  "contradictionsFound": ["0+ potential contradictions with existing canon, if any"],
  "reconciliationOptions": ["0-3 ways to reconcile contradictions (region/time/propaganda) if contradictionsFound is non-empty"]
}

Constraints:
- Do not retcon.
- Keep canon lines concrete, not abstract.
- If unsure, put it as an open thread instead of canon.

Bible summary:
${bibleSummaryForModel(bible)}

Assistant last transcript:
${lastAiTranscript}
`.trim();
}

export function recapPrompt(bible: SocietyBible): string {
  return `
Return STRICT JSON only (no markdown) with:
{
  "canonRecap": ["7 bullet recap of canon so far"],
  "openThreads": ["5 open threads worth exploring next"],
  "nextMoves": ["3 suggested directions (e.g., school/law/architecture)"]
}

Bible summary:
${bibleSummaryForModel(bible)}
`.trim();
}

export function recapNarrationPrompt(bible: SocietyBible, imageCaptions: string[]): string {
  const captions = imageCaptions
    .filter(Boolean)
    .slice(-8)
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");
  return `
Give a short, engaging spoken recap of the society so far, based ONLY on the canon summary and image captions.
Keep it concise (4-6 sentences), friendly, and in-world. Avoid questions.
Describe each image in order, matching the image currently on screen (one short sentence per image).
Do NOT invent new facts. If details are missing, say so briefly and stay neutral.
End with one inviting prompt asking the player what part of the society to develop next.

Canon summary:
${bibleSummaryForModel(bible)}

Image captions:
${captions || "- (no images yet)"}
`.trim();
}

export function finalBreakdownPrompt(bible: SocietyBible): string {
  return `
You are creating a permanent record of a fictional society invented in the improv game “Society”.

Return STRICT JSON only (no markdown) with:
{
  "title": "short evocative society name",
  "logline": "1 sentence hook",
  "tone": "e.g. utopian / dystopian / hellish / comic / weird / realist",
  "core_values": ["3-7"],
  "status_markers": ["2-6"],
  "institutions": {
    "education": "2-4 sentences",
    "law": "2-4 sentences",
    "care": "2-4 sentences",
    "media": "2-4 sentences",
    "religion_or_myth": "2-4 sentences"
  },
  "daily_life": {
    "a_day_in_the_life": "4-7 sentences",
    "housing": "1-3 sentences",
    "work_rhythm": "1-3 sentences",
    "food_leisure": "1-3 sentences"
  },
  "aesthetics": {
    "architecture": "1-3 sentences",
    "fashion": "1-3 sentences",
    "public_ritual": "1-3 sentences"
  },
  "constraints": {
    "environment": "1-2 sentences",
    "resources": "1-2 sentences",
    "tech_level": "1-2 sentences"
  },
  "foreign_policy": "1-3 sentences",
  "taboos": ["1-5"],
  "open_threads": ["up to 8"],
  "canon_changelog": ["up to 12 canon lines, newest last"]
}

Rules:
- Use only what is supported by canon; if something is missing, leave it vague rather than inventing a totally new system.
- If the society is dark, violence may be mentioned, but keep it non-graphic and focused on institutions/rituals/consequences (no gore).

Bible summary:
${bibleSummaryForModel(bible)}
`.trim();
}

export function imagePromptFromBible(bible: SocietyBible): string {
  const recentCanon = bible.changelog.slice(-10).map((c) => c.entry).join("; ");
  return `
Illustrate a single 1:1 image in a consistent retro “32-bit” pixel-art aesthetic (SNES/PS1-era look).
Keep crisp pixels, limited palette, subtle dithering, and no modern photorealism.
Avoid readable text in the image.

Canon (recent): ${recentCanon || "none"}

Scene: A public civic space that embodies the society's core values.
Include people in a natural candid moment; show architecture, clothing, signage-free design cues, and atmosphere.
`.trim();
}

export function imageSceneProposalPrompt(bible: SocietyBible, styleGuide: string): string {
  return `
You are helping illustrate a fictional society invented in the improv game “Society”.

Return STRICT JSON only (no markdown) with:
{
  "title": "short scene title",
  "caption": "ONE sentence describing what aspect of the society this image illustrates (a statement, not a question)",
  "seedFacts": ["3-7 short canon facts you are using as anchors (quote/paraphrase from canon)"],
  "styleGuide": "a stable, reusable style guide for this society's images. MUST be '64-bit pixel art' (retro console era), plus palette, lighting, and mood. If provided below, keep it consistent and return it unchanged.",
  "prompt": "a single, rich image prompt for a square image in 64-bit pixel art that embodies the society's aesthetics and daily life",
  "negativePrompt": "things to avoid (e.g., text, logos, photorealism, smooth gradients, vector art, gore, explicit violence)"
}

Guidelines:
- Use canon; if aesthetics are unclear, choose a safe, grounded interpretation consistent with recent canon.
- Do not default to medieval or any specific era unless canon explicitly indicates it.
- If canon is thin, keep the scene neutral and ask a clarifying question in the caption.
- The caption MUST be a brief descriptive statement of what's happening (no questions).
- Your prompt MUST clearly reflect the seedFacts. If a seedFact is about architecture/clothing/rituals, show it.
- Prefer specific materials, lighting, clothing, architecture, and atmosphere.
- Style is ALWAYS 64-bit pixel art: crisp pixels, richer palette, subtle dithering, strong silhouettes, readable shapes.
- Dark societies are allowed, but keep violence non-graphic (no gore). No explicit sexual content or nudity.
- The image should be square (1:1) and contain no readable text.

Bible summary:
${bibleSummaryForModel(bible)}

Current style guide (if any):
${styleGuide || "(none yet)"}
`.trim();
}
