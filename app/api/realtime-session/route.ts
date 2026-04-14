import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const sdp = await req.text();
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
  }

  const url = new URL(req.url);
  const voice = url.searchParams.get("voice") ?? "marin";
  // Default to full gpt-realtime for reliable WebRTC audio; set OPENAI_REALTIME_MODEL=gpt-realtime-mini to save cost.
  const model =
    process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";

  // language=en for Whisper. Keep transcription.prompt to short keywords only — long
  // sentences are often hallucinated into the user transcript as if spoken.
  const sessionConfig = {
    type: "realtime",
    model,
    audio: {
      output: { voice },
      input: {
        noise_reduction: { type: "near_field" },
        transcription: {
          model: "whisper-1",
          language: "en",
          // Short keyword-style hint only (Whisper-1). Long instructions get echoed into transcripts.
          prompt: "English, Society game, core value, worldbuilding, canon.",
        },
      },
    },
  };

  const fd = new FormData();
  fd.set("sdp", sdp);
  fd.set("session", JSON.stringify(sessionConfig));

  const r = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: fd,
  });

  const answerSdp = await r.text();

  if (!r.ok) {
    return NextResponse.json(
      { error: "Realtime call creation failed", status: r.status, details: answerSdp },
      { status: 500 }
    );
  }

  return new NextResponse(answerSdp, {
    status: 200,
    headers: { "Content-Type": "application/sdp" },
  });
}
