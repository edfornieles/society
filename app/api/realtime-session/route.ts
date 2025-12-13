import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const sdp = await req.text();
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
  }

  // Minimal session config per Realtime WebRTC unified interface examples:
  // /v1/realtime/calls expects multipart form with "sdp" and "session".
  const sessionConfig = {
    type: "realtime",
    model: "gpt-realtime",
    // Choose a default voice here; client can override by passing ?voice= in the request.
    audio: { output: { voice: "marin" } },
  };

  const url = new URL(req.url);
  const voice = url.searchParams.get("voice");
  if (voice) {
    (sessionConfig.audio.output as any).voice = voice;
  }

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
