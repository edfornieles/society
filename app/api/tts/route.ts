import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * POST /api/tts — proxies to a local Pocket-TTS server (Kyutai, self-hosted,
 * free). Kept behind our own route rather than called directly from the
 * browser so the actual TTS host (localhost today, a small always-on box
 * later for production) is a single server-side env var, not baked into
 * client code.
 */
export async function POST(req: Request) {
  try {
    const { text, voice } = (await req.json().catch(() => ({}))) as {
      text?: string;
      voice?: string;
    };

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }

    const baseUrl = (process.env.POCKET_TTS_URL?.trim() || "http://localhost:8123").replace(/\/+$/, "");
    // Default voice: "Watercooler" from Unmute.sh's demo — VCTK speaker p329,
    // pulled from Kyutai's shared public voice catalog (already cached locally
    // via huggingface_hub after first use, so no repeat downloads).
    const defaultVoice = process.env.POCKET_TTS_VOICE?.trim() || "hf://kyutai/tts-voices/vctk/p329_023.wav";

    // Pocket-TTS only exists on localhost, so in cloud deploys it is always
    // unreachable — fall through to OpenAI TTS there instead of going silent.
    // Locally nothing changes: Pocket answers first and keeps the Watercooler
    // voice. TTS_PROVIDER=openai forces the fallback path explicitly.
    const forceOpenAi = (process.env.TTS_PROVIDER?.trim().toLowerCase() ?? "") === "openai";
    if (!forceOpenAi) {
      try {
        const form = new FormData();
        form.set("text", text);
        form.set("voice_url", voice?.trim() || defaultVoice);
        const r = await fetch(`${baseUrl}/tts`, { method: "POST", body: form });
        if (r.ok) {
          const audio = await r.arrayBuffer();
          return new Response(audio, {
            status: 200,
            headers: { "Content-Type": "audio/wav" },
          });
        }
      } catch {
        // unreachable — try the hosted fallback below
      }
    }

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "Pocket-TTS server not reachable and no OPENAI_API_KEY for fallback TTS" },
        { status: 502 }
      );
    }
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL?.trim() || "gpt-4o-mini-tts",
        voice: process.env.OPENAI_TTS_VOICE?.trim() || "ash",
        input: text,
        response_format: "mp3",
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return NextResponse.json(
        { error: `Fallback TTS error: ${r.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}` },
        { status: 502 }
      );
    }
    const audio = await r.arrayBuffer();
    return new Response(audio, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  } catch (e: any) {
    const message = String(e?.message ?? "TTS request failed");
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
