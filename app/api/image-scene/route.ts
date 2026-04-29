import { NextResponse } from "next/server";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import { imageSceneProposalPrompt } from "@/lib/prompts";
import type { SocietyBible } from "@/lib/societyBible";

export const runtime = "nodejs";

const DEFAULT_STYLE_GUIDE =
  "64-bit retro pixel art (late PS1/N64-era). Crisp pixels with richer detail, broader palette, subtle dithering, strong silhouettes, readable shapes. Cozy cinematic framing translated into pixel art. No photorealism, no vector/flat icons, no smooth gradients. No readable text/logos/watermarks.";

const ONBOARDING_IMAGE_PATTERN =
  /\b(core value|most important thing in this society|defining society|collaboration|pivotal moment|human asserts|co-creator|inquiry)\b/i;

function pickConcreteCanonLine(bible: SocietyBible): string {
  const generic =
    /started a session|session started|most important thing in this society|core value|human asserts|co-creator|collaboration|inquiry on/i;
  const recent = bible.changelog
    .slice()
    .sort((a, b) => b.turn - a.turn)
    .map((c) => String(c.entry ?? "").trim())
    .find((line) => line && !generic.test(line));
  return recent || String(bible.lastAiUtterance ?? "").trim() || String(bible.lastUserUtterance ?? "").trim();
}

function compactTitleFromLine(line: string): string {
  const words = line.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 5);
  const candidate = words.join(" ").trim();
  return candidate ? candidate.replace(/\b\w/g, (ch) => ch.toUpperCase()) : "Society Scene";
}

function resolveImageStorageRoot(): string {
  const envRoot = process.env.SOCIETY_STORAGE_ROOT?.trim();
  if (envRoot) return envRoot;
  return process.cwd();
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
    const prompt = imageSceneProposalPrompt(bible, styleGuide ?? DEFAULT_STYLE_GUIDE);

    const chat = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an art director for an illustrated worldbuilding game. Respond ONLY with the JSON object requested — no markdown, no extra text. seedFacts must be traceable to the ANCHOR in the user message; at least two must come from the last human and/or last AI lines when present. The image must depict that latest exchange, not a random earlier topic. Do not invent institutions or customs not implied there.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 1024,
    });

    const raw = chat.choices[0]?.message?.content ?? "";
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Scene proposal JSON parse failed", raw }, { status: 500 });
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
        imagePrompt = `Depict a single concrete in-world moment from this canon line: "${concreteLine}". Show named roles/objects/actions from that line only. No onboarding dialogue, no "core value" explanation, no meta collaboration framing.`;
      }
    }

    if (!imagePrompt) {
      return NextResponse.json({ error: "No image prompt in scene proposal", parsed }, { status: 500 });
    }

    const fullPrompt = [
      resolvedStyleGuide ? `STYLE GUIDE (keep consistent): ${resolvedStyleGuide}` : "",
      seedFacts.length ? `CANON SEEDS (must reflect):\n- ${seedFacts.join("\n- ")}` : "",
      imagePrompt,
      `Avoid: ${negativePrompt}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    // Step 2: generate the image.
    const img = await client.images.generate({
      model: "gpt-image-1",
      prompt: fullPrompt,
      n: 1,
      size: "1024x1024",
    });

    const b64 = img.data?.[0]?.b64_json;
    if (!b64) {
      return NextResponse.json({ error: "No image data returned" }, { status: 500 });
    }

    // Save PNG to disk so images are accessible outside the browser.
    let imagePath: string | null = null;
    try {
      const sid = sessionId ?? "unknown-session";
      const storageRoot = resolveImageStorageRoot();
      const imageDir = path.join(storageRoot, "public", "game-images", sid);
      await fs.mkdir(imageDir, { recursive: true });
      const filename = `${Date.now()}.png`;
      await fs.writeFile(path.join(imageDir, filename), Buffer.from(b64, "base64"));
      // Expose as a public URL (served by Next.js static file handler)
      imagePath = `/game-images/${sid}/${filename}`;
    } catch {
      // Non-fatal — the b64 is still returned for display
    }

    return NextResponse.json({
      b64,
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
