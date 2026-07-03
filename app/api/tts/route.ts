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

    // WATERCOOLER ONLY — hard product rule (user directive 2026-07-03): the
    // Kyutai/Pocket-TTS Watercooler voice is the game's voice, full stop.
    // There is deliberately NO fallback to any other TTS: a different voice
    // mid-session is worse than a silent sentence (the text still renders,
    // and the tunnel watchdog restores the voice within a minute). Do not
    // reintroduce an OpenAI/hosted substitute without an explicit fresh ask.
    const form = new FormData();
    form.set("text", text);
    form.set("voice_url", voice?.trim() || defaultVoice);
    const r = await fetch(`${baseUrl}/tts`, { method: "POST", body: form });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return NextResponse.json(
        { error: `Pocket-TTS error: ${r.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}` },
        { status: 502 }
      );
    }
    const audio = await r.arrayBuffer();
    return new Response(audio, {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    });
  } catch (e: any) {
    const message = String(e?.message ?? "TTS request failed");
    const unreachable = message.includes("fetch failed") || message.includes("ECONNREFUSED");
    return NextResponse.json(
      {
        error: unreachable
          ? "Watercooler voice server unreachable — locally: pocket-tts serve --port 8123; deployed: run scripts/tts-tunnel.sh"
          : message,
      },
      { status: 502 }
    );
  }
}
