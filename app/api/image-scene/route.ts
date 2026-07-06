import { NextResponse } from "next/server";
import OpenAI from "openai";
import { imageSceneProposalPrompt } from "@/lib/prompts";
import type { SocietyBible } from "@/lib/societyBible";
import { putGeneratedImage } from "@/lib/serverStorage";
import { comfyEnabled, generateImageViaComfy } from "@/lib/comfyImage";

export const runtime = "nodejs";

const DEFAULT_STYLE_GUIDE =
  "64-bit retro pixel art (late PS1/N64-era). Crisp pixels with richer detail, broader palette, subtle dithering, strong silhouettes, readable shapes. Clean contemporary cinematic framing translated into pixel art — bold modern color, not warm nostalgia. No photorealism, no vector/flat icons, no smooth gradients. No readable text/logos/watermarks.";

const ONBOARDING_IMAGE_PATTERN =
  /\b(core value|most important thing in this society|defining society|collaboration|pivotal moment|human asserts|co-creator|inquiry|engaging discussion|key pillar|pillar of|encourages exploration|exploration of (their|the) (core )?values?|gathering space|two characters? (animat|discuss|talk|chat|debat)|characters? animatedly|discuss(ing|ion) (of|on|about) (honor|art|love|technology|surveillance|the core|the value|values|the most))\b/i;

function isAbstractCanonLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 12) return true;
  const wordCount = t.split(/\s+/).length;
  if (wordCount < 6) return true;
  if (
    /^(society|the society|this society|citizens?|people|everyone|life|culture)\s+(values|prioritizes|prioritises|places|cherishes|reveres|holds|considers|treats|honors|honours|sees|views|emphasizes|emphasises)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/^(honor|art|technology|love|truth|surveillance|theatre|theater|beauty|music|knowledge)\s+is\s+(the\s+)?(most|foundational|central|key|primary|core|defining)\b/i.test(t)) {
    return true;
  }
  if (/^the\s+most\s+important\s+thing\b/i.test(t)) return true;
  return false;
}

// The co-creator's lines are "mirror + QUESTION" (e.g. "Can you describe a club
// where people go dancing?"). A question is a prompt, not an established fact —
// illustrating it produces a caption that just parrots the question back
// instead of depicting a concrete moment. Exclude questions from image anchors.
function isQuestion(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.endsWith("?")) return true;
  if (
    /^(can|could|would|will|do|does|did|is|are|was|were|have|has|should|what|how|why|where|when|who|which|tell me|describe|imagine|picture|think about|what if)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/** Strip a trailing question clause from a "statement. question?" line so we can
 *  still illustrate the statement part rather than discarding the whole line. */
function stripTrailingQuestion(line: string): string {
  const sentences = line.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return isQuestion(line) ? "" : line.trim();
  const statements = sentences.map((s) => s.trim()).filter((s) => s && !isQuestion(s));
  return statements.join(" ").trim();
}

// The caption is shown to the player as a WRITTEN description. A raw Whisper
// transcript of speech ("if they yeah if they get away with it", "it's about,
// you know, like the film Wall Street") reads as nonsense there. Detect that.
function looksLikeRawSpeech(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(you know|i mean|kind of|sort of|um+|uh+|er+|yeah|gonna|wanna)\b/.test(t)) return true;
  if (/\b(\w+)\s+\1\b/.test(t)) return true; // immediate word repetition: "they they", "if they if they"
  if (/(it'?s|its)\s+(not\s+)?about\b[\s\S]*(it'?s|its)\s+(not\s+)?about\b/.test(t)) return true;
  if (/\blike,?\s+like\b/.test(t)) return true;
  return false;
}

/** Scrub verbal tics / stutters out of a line so it reads as a written caption. */
function cleanCaption(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  t = t.replace(/\b(\w+)(\s+\1\b)+/gi, "$1"); // collapse repeated words
  t = t.replace(/\b(you know|i mean|kind of|sort of|um+|uh+|er+|yeah)\b[,]?/gi, " ");
  t = t.replace(/\blike,\s*/gi, "");
  t = t.replace(/\s+/g, " ").replace(/^[,.\s]+|[,\s]+$/g, "").trim();
  return t;
}

function pickConcreteCanonLine(bible: SocietyBible): string {
  const generic =
    /started a session|session started|most important thing in this society|core value|human asserts|co-creator|collaboration|inquiry on/i;
  const usable = (line: string) =>
    line && !generic.test(line) && !isAbstractCanonLine(line) && !isQuestion(line) && !looksLikeRawSpeech(line);

  const recent = bible.changelog
    .slice()
    .sort((a, b) => b.turn - a.turn)
    .map((c) => String(c.entry ?? "").trim())
    .find(usable);
  if (recent) return recent;

  const lastUser = String(bible.lastUserUtterance ?? "").trim();
  if (usable(lastUser)) return lastUser;

  // The AI line is usually mirror + question — keep only the statement part.
  const lastAiStatement = stripTrailingQuestion(String(bible.lastAiUtterance ?? "").trim());
  if (usable(lastAiStatement)) return lastAiStatement;

  return stripTrailingQuestion(lastUser) || lastAiStatement || "";
}

function compactTitleFromLine(line: string): string {
  const words = line.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 5);
  const candidate = words.join(" ").trim();
  return candidate ? candidate.replace(/\b\w/g, (ch) => ch.toUpperCase()) : "Society Scene";
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);
}

function hasStrongAnchorOverlap(seedFacts: string[], line: string): boolean {
  const anchorWords = new Set(normalizeWords(line));
  if (anchorWords.size === 0) return false;
  const seedWords = new Set(normalizeWords(seedFacts.join(" ")));
  let overlap = 0;
  for (const w of anchorWords) {
    if (seedWords.has(w)) overlap += 1;
  }
  return overlap >= 2;
}

export async function POST(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
    }

    const { bible, styleGuide, sessionId } = (await req.json().catch(() => ({}))) as {
      bible?: SocietyBible;
      styleGuide?: string;
      sessionId?: string;
    };

    if (!bible) {
      return NextResponse.json({ error: "Missing bible" }, { status: 400 });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Step 1: ask a chat model to build a canon-consistent image scene proposal.
    // One retry on parse failure — a malformed JSON response here is a benign,
    // transient LLM formatting slip (not a moderation issue), and without a
    // retry it silently killed that turn's image entirely.
    const prompt = imageSceneProposalPrompt(bible, styleGuide ?? DEFAULT_STYLE_GUIDE);
    const sceneSystemMessage =
      "You are an art director for an illustrated worldbuilding game. Respond ONLY with the JSON object requested — no markdown, no extra text. seedFacts must be traceable to the ANCHOR in the user message; at least two must come from the last human and/or last AI lines when present. The image must depict that latest exchange, not a random earlier topic. Do not invent institutions or customs not implied there.";

    let raw = "";
    let parsed: Record<string, any> = {};
    let parseError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const chat = await client.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sceneSystemMessage },
          { role: "user", content: prompt },
        ],
        max_tokens: 1024,
      });
      raw = chat.choices[0]?.message?.content ?? "";
      try {
        parsed = JSON.parse(raw);
        parseError = null;
        break;
      } catch {
        parseError = "Scene proposal JSON parse failed";
      }
    }
    if (parseError) {
      return NextResponse.json({ error: parseError, raw }, { status: 500 });
    }

    let title = String(parsed.title ?? "Society scene");
    let caption = String(parsed.caption ?? "");
    const seedFacts: string[] = Array.isArray(parsed.seedFacts)
      ? parsed.seedFacts.map(String).slice(0, 8)
      : [];
    const resolvedStyleGuide = String(parsed.styleGuide ?? styleGuide ?? DEFAULT_STYLE_GUIDE);
    let imagePrompt = String(parsed.prompt ?? "");
    const negativePrompt = String(
      parsed.negativePrompt ??
        "text, logos, watermark, explicit nudity, explicit sexual content, gore, graphic violence"
    );

    const looksLikeOnboardingMeta =
      ONBOARDING_IMAGE_PATTERN.test(`${title} ${caption} ${imagePrompt}`) && bible.turnCount > 0;
    if (looksLikeOnboardingMeta) {
      const concreteLine = pickConcreteCanonLine(bible);
      if (concreteLine) {
        title = compactTitleFromLine(concreteLine);
        caption = concreteLine;
        imagePrompt = [
          `Depict a single concrete in-world moment from this canon line: "${concreteLine}".`,
          `Show named roles/objects/actions/places from that line only.`,
          `BANNED: people sitting/standing around discussing the society's values; "two characters" talking; any meeting, panel, debate, or gathering whose purpose is to discuss the core value; any speech bubbles or implied conversation about ideas; signage about the society's ideals; abstract personification of "${bible.canon.coreValues?.[0] ?? "the value"}".`,
          `Required: a physical action happening in a specific physical place — a person doing a specific thing with specific objects, mid-motion. The image must read as a moment in someone's day, not as a meta illustration of the society's theme.`,
        ].join("\n");
      }
    }

    const lastUserLine = String(bible.lastUserUtterance ?? "").trim();
    const missingLatestAnchor =
      lastUserLine.length > 0 &&
      !isAbstractCanonLine(lastUserLine) &&
      !hasStrongAnchorOverlap(seedFacts, lastUserLine);
    if (missingLatestAnchor) {
      const forcedLine = lastUserLine;
      // Draw from the raw line (accuracy), but the CAPTION shown to the player
      // must be clean — prefer the cleaned changelog fact for this turn, else a
      // scrubbed version of the line; never the raw transcript.
      const cleanLine = pickConcreteCanonLine(bible) || cleanCaption(forcedLine);
      title = compactTitleFromLine(cleanLine || forcedLine);
      caption = cleanLine || cleanCaption(forcedLine);
      imagePrompt = [
        `Depict a concrete moment from this exact latest user line: "${forcedLine}".`,
        `Use specific nouns/actions from that line and show one frozen in-world action.`,
        `Do not drift to older canon or generic symbolism unless this line explicitly references it.`,
        `BANNED: generic crowd discussions, abstract "society values X" illustrations, or scenic filler that does not include concrete objects/actions from the line.`,
      ].join("\n");
    }

    // Final caption hygiene: the caption is shown to the player and must read as
    // a succinct WRITTEN description of the scene — never a question (the
    // co-creator's prompt), never a raw spoken transcript (verbal tics /
    // stutters), never a rambling paragraph. Re-anchor on a clean canon fact
    // when possible; otherwise scrub the caption we have.
    const captionBad =
      isQuestion(caption) ||
      isQuestion(title) ||
      looksLikeRawSpeech(caption) ||
      caption.split(/\s+/).length > 26;
    if (captionBad) {
      const factLine = pickConcreteCanonLine(bible); // clean, non-question, non-raw
      if (factLine) {
        title = compactTitleFromLine(factLine);
        caption = factLine;
        imagePrompt = [
          `Depict a single concrete in-world moment from this established fact: "${factLine}".`,
          `Show a specific person doing a specific action with specific objects in a specific place, mid-motion.`,
          `BANNED: depicting or captioning any question; "two characters discussing"; any signage or speech about the society's ideas.`,
        ].join("\n");
      } else {
        caption = cleanCaption(stripTrailingQuestion(caption) || caption);
      }
    }
    // Always scrub the final caption/title of stray tics before returning.
    caption = cleanCaption(caption);
    if (looksLikeRawSpeech(title) || isQuestion(title)) title = compactTitleFromLine(cleanCaption(title) || caption);

    if (!imagePrompt) {
      return NextResponse.json({ error: "No image prompt in scene proposal", parsed }, { status: 500 });
    }

    // Anti-medieval enforcement at the FINAL prompt (not just the scene LLM):
    // retro pixel art has a strong latent pull toward fantasy-RPG imagery
    // (castles, knights, torches), so the era must be pinned and the medieval
    // furniture explicitly negated here, where it actually reaches the image
    // model — otherwise the look drags every scene back to a "rustic medieval"
    // village regardless of what the society's canon actually implies.
    const periodDirective =
      "PERIOD/SETTING — DEFAULT TO THE PRESENT DAY or a near-future version of it: contemporary clothing, materials, lighting, architecture and technology. Render a PAST era (medieval, Victorian, 1920s, ancient, etc.) ONLY if a canon seed EXPLICITLY places the society in the past — 'fashion matters here' or 'water is currency' says nothing about era and must NOT drift old-timey. The retro pixel-art STYLE is purely a rendering technique; it does not mean the WORLD is retro. No castles, knights, gas lamps, bonnets, horse-drawn anything, or rustic village squares unless the canon demands them. Palette: bold and contemporary, not sepia/amber nostalgia.";
    const MEDIEVAL_NEGATIVES =
      "medieval setting, feudal setting, fantasy RPG, castle, stone keep, fortress walls, knight, plate armor, chainmail, sword, shield, lit torches, thatched roof, cobblestone street, rustic village square, peasant tunic, wooden market stalls, victorian street, gas lamps, gaslight, bonnet, top hat, horse-drawn carriage, corset, petticoat, sepia tone, vintage nostalgia, old-timey";
    const combinedNegative = [negativePrompt, MEDIEVAL_NEGATIVES].filter(Boolean).join(", ");

    const fullPrompt = [
      resolvedStyleGuide ? `STYLE GUIDE (keep consistent): ${resolvedStyleGuide}` : "",
      seedFacts.length ? `CANON SEEDS (must reflect):\n- ${seedFacts.join("\n- ")}` : "",
      imagePrompt,
      periodDirective,
      `Avoid: ${combinedNegative}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    // Step 2: generate the image. Landscape fits the full-viewport background
    // frame (object-fit: cover) far better than a square crop did.
    // Cost note: gpt-image-1-mini at "medium" quality is roughly 8-12x
    // cheaper than gpt-image-1 with quality left unset (which defaults to a
    // costly tier). "low" was tried and rejected — it lost the pixel-art
    // texture entirely and rendered as a smooth painterly illustration;
    // "medium" is the cheapest tier that still reads as genuine pixel art.
    let pngBytes: Buffer;
    if (comfyEnabled()) {
      pngBytes = await generateImageViaComfy({
        prompt: fullPrompt,
        negativePrompt: combinedNegative,
        width: 1536,
        height: 1024,
      });
    } else {
      const img = await client.images.generate({
        model: process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1-mini",
        prompt: fullPrompt,
        n: 1,
        size: "1536x1024",
        quality: (process.env.OPENAI_IMAGE_QUALITY?.trim() as "low" | "medium" | "high") || "medium",
      });
      const b64 = img.data?.[0]?.b64_json;
      if (!b64) {
        return NextResponse.json({ error: "No image data returned" }, { status: 500 });
      }
      pngBytes = Buffer.from(b64, "base64");
    }

    // Save PNG to storage (R2 when configured, local disk otherwise).
    // putGeneratedImage logs and returns null on failure; b64 is still returned
    // for immediate display and kept in the saved record when imagePath is null.
    const imagePath = await putGeneratedImage(sessionId ?? "unknown-session", pngBytes, `${Date.now()}.png`);

    return NextResponse.json({
      b64: pngBytes.toString("base64"),
      imagePath,
      title,
      caption,
      seedFacts,
      styleGuide: resolvedStyleGuide,
      promptUsed: fullPrompt.slice(0, 4000),
    });
  } catch (e: any) {
    const statusRaw = Number(e?.status ?? e?.statusCode ?? 500);
    const status = statusRaw >= 400 && statusRaw < 600 ? statusRaw : 500;
    const message = String(e?.message ?? "Image scene generation failed");
    const code = String(e?.code ?? e?.error?.code ?? "");
    const moderation =
      code === "moderation_blocked" || String(e?.error?.code ?? "") === "moderation_blocked";
    return NextResponse.json(
      { error: message, code: moderation ? "moderation_blocked" : code },
      { status: moderation ? 400 : status }
    );
  }
}
