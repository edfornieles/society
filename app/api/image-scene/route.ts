import { NextResponse } from "next/server";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import { imageSceneProposalPrompt } from "@/lib/prompts";
import type { SocietyBible } from "@/lib/societyBible";

export const runtime = "nodejs";

const DEFAULT_STYLE_GUIDE =
  "64-bit retro pixel art (late PS1/N64-era). Crisp pixels with richer detail, broader palette, subtle dithering, strong silhouettes, readable shapes. Cozy cinematic framing translated into pixel art. No photorealism, no vector/flat icons, no smooth gradients. No readable text/logos/watermarks.";

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
            "You are an art director for an illustrated worldbuilding game. Respond ONLY with the JSON object requested — no markdown, no extra text. seedFacts must be traceable to the ANCHOR and changelog lines in the user message — do not invent new institutions, geographies, or customs that are not implied there. Captions and image prompts must show one specific moment from those facts, not generic society imagery.",
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

    const title = String(parsed.title ?? "Society scene");
    const caption = String(parsed.caption ?? "");
    const seedFacts: string[] = Array.isArray(parsed.seedFacts)
      ? parsed.seedFacts.map(String).slice(0, 8)
      : [];
    const resolvedStyleGuide = String(parsed.styleGuide ?? styleGuide ?? DEFAULT_STYLE_GUIDE);
    const imagePrompt = String(parsed.prompt ?? "");
    const negativePrompt = String(
      parsed.negativePrompt ??
        "text, logos, watermark, explicit nudity, explicit sexual content, gore, graphic violence"
    );

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
      size: "1536x1024",
    });

    const b64 = img.data?.[0]?.b64_json;
    if (!b64) {
      return NextResponse.json({ error: "No image data returned" }, { status: 500 });
    }

    // Save PNG to disk so images are accessible outside the browser.
    let imagePath: string | null = null;
    try {
      const sid = sessionId ?? "unknown-session";
      const imageDir = path.join(process.cwd(), "public", "game-images", sid);
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
