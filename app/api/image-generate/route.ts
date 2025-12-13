import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
  }
  const { prompt, size } = (await req.json().catch(() => ({}))) as { prompt?: string; size?: string };

  if (!prompt || typeof prompt !== "string") {
    return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const img = await client.images.generate({
      model: "gpt-image-1",
      prompt,
      n: 1,
      size: (size as any) ?? "1024x1024",
    });

    const b64 = img.data?.[0]?.b64_json;
    if (!b64) {
      return NextResponse.json({ error: "No image returned" }, { status: 500 });
    }

    return NextResponse.json({ b64, mime: "image/png" });
  } catch (e: any) {
    // Don't crash the dev server / error overlay; surface a structured error to the client.
    const status = Number(e?.status ?? e?.statusCode ?? 500);
    const requestId = String(e?.requestID ?? e?.requestId ?? "");
    const code = String(e?.code ?? e?.error?.code ?? "");
    const message = String(e?.message ?? "Image generation failed");
    return NextResponse.json({ error: message, code, requestId }, { status: status >= 400 && status < 600 ? status : 500 });
  }
}
