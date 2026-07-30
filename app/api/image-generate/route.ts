import { NextResponse } from "next/server";
import OpenAI from "openai";
import { putGeneratedImage } from "@/lib/serverStorage";
import { comfyEnabled, generateImageViaComfy } from "@/lib/comfyImage";

export const runtime = "nodejs";

const DEFAULT_NEGATIVE_PROMPT =
  "text, logos, watermark, explicit nudity, explicit sexual content, gore, graphic violence, photorealistic, smooth gradients, vector art";

export async function POST(req: Request) {
  try {
    const { prompt, size, sessionId } = (await req.json().catch(() => ({}))) as {
      prompt?: string;
      size?: string;
      sessionId?: string;
    };

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
    }

    let pngBytes: Buffer;

    if (comfyEnabled()) {
      const [w, h] = String(size ?? "1024x1024").split("x").map((n) => parseInt(n, 10));
      pngBytes = await generateImageViaComfy({
        prompt,
        negativePrompt: DEFAULT_NEGATIVE_PROMPT,
        width: Number.isFinite(w) ? w : 1536,
        height: Number.isFinite(h) ? h : 1024,
      });
    } else {
      if (!process.env.OPENAI_API_KEY) {
        return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
      }
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const img = await client.images.generate({
        model: process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1-mini",
        prompt,
        n: 1,
        size: (size as any) ?? "1024x1024",
        quality: (process.env.OPENAI_IMAGE_QUALITY?.trim() as "low" | "medium" | "high") || "medium",
      });
      const b64 = img.data?.[0]?.b64_json;
      if (!b64) {
        return NextResponse.json({ error: "No image returned" }, { status: 500 });
      }
      pngBytes = Buffer.from(b64, "base64");
    }

    // Persist so a rerolled image survives reload, same as the main scene path.
    const imagePath = await putGeneratedImage(sessionId ?? "unknown-session", pngBytes, `${Date.now()}.png`);

    return NextResponse.json({ b64: pngBytes.toString("base64"), imagePath, mime: "image/png" });
  } catch (e: any) {
    // Keep this handler resilient: always return structured JSON, never throw.
    const statusRaw = Number(e?.status ?? e?.statusCode ?? 500);
    const status = statusRaw >= 400 && statusRaw < 600 ? statusRaw : 500;
    const requestId = String(e?.requestID ?? e?.requestId ?? "");
    const code = String(e?.code ?? e?.error?.code ?? "");
    const message = String(e?.message ?? "Image generation failed");

    // Normalized error for moderation blocks so the client can show a clean message.
    const moderation = code === "moderation_blocked" || String(e?.error?.code ?? "") === "moderation_blocked";
    return NextResponse.json(
      { error: message, code: moderation ? "moderation_blocked" : code, requestId },
      { status: moderation ? 400 : status }
    );
  }
}
