import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

/**
 * POST /api/transcribe — one-shot Whisper transcription for the text console's
 * "speak instead of type" button. Deliberately NOT the realtime voice session:
 * no WebRTC, no TTS output, no persistent connection — just cheap speech-to-text
 * so text-mode dev iteration can stay voice-input without voice-output cost.
 */
export async function POST(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
    }

    const form = await req.formData().catch(() => null);
    const audio = form?.get("audio");
    if (!audio || !(audio instanceof Blob)) {
      return NextResponse.json({ error: "Missing audio" }, { status: 400 });
    }
    // Optional context hint the caller can send to bias transcription toward the
    // words this society actually uses (core value, recent canon terms, the last
    // question the agent asked). The transcription models accept a free-text
    // `prompt` that nudges spelling + vocabulary — this is what stops "beach
    // culture" being heard as bare "culture". Kept short; over-long prompts hurt.
    const hintRaw = typeof form?.get("hint") === "string" ? String(form.get("hint")) : "";
    const hint = hintRaw.trim().slice(0, 240);

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    // Whisper sniffs the format from the filename extension + content type, so
    // both must match what the browser actually recorded. Safari records MP4,
    // Chrome/Firefox WebM — derive the extension from the uploaded blob's type
    // rather than hardcoding .webm (a mislabeled file is rejected outright).
    const uploadedType = (audio.type || "audio/webm").split(";")[0];
    const ext = uploadedType.includes("mp4") || uploadedType.includes("m4a")
      ? "mp4"
      : uploadedType.includes("ogg")
      ? "ogg"
      : uploadedType.includes("mpeg")
      ? "mp3"
      : uploadedType.includes("wav")
      ? "wav"
      : "webm";
    const file = new File([audio], `speech.${ext}`, { type: uploadedType });

    // Default is whisper-1 (per request): fastest round-trip (~0.8s) and the
    // context `hint` below still biases it toward this society's vocabulary,
    // which is what mitigated the "it keeps mishearing me" failures. Swap to
    // gpt-4o-mini-transcribe (~0.9s, a touch more accurate) or gpt-4o-transcribe
    // (~2.2s, slower) via TRANSCRIBE_MODEL without touching code.
    const model = process.env.TRANSCRIBE_MODEL || "whisper-1";
    let text = "";
    try {
      const result = await client.audio.transcriptions.create({
        file,
        model,
        language: "en",
        ...(hint ? { prompt: hint } : {}),
        // Temperature 0 = most literal transcription (no "creative" rewording),
        // which reduces mishears on unusual proper nouns/phrases.
        temperature: 0,
      });
      text = result.text ?? "";
    } catch (primaryErr: any) {
      // Never let a model/param incompatibility break voice input entirely —
      // silently mishearing is bad, but transcribing NOTHING is worse. Fall
      // back to the always-available whisper-1 with the same context hint.
      if (model === "whisper-1") throw primaryErr;
      const fallback = await client.audio.transcriptions.create({
        file,
        model: "whisper-1",
        language: "en",
        ...(hint ? { prompt: hint } : {}),
      });
      text = fallback.text ?? "";
    }

    return NextResponse.json({ text });
  } catch (e: any) {
    const statusRaw = Number(e?.status ?? e?.statusCode ?? 500);
    const status = statusRaw >= 400 && statusRaw < 600 ? statusRaw : 500;
    const message = String(e?.message ?? "Transcription failed");
    return NextResponse.json({ error: message }, { status });
  }
}
