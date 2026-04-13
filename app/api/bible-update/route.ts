import { NextResponse } from "next/server";
import OpenAI from "openai";
import { oobUpdatePrompt } from "@/lib/prompts";
import type { SocietyBible } from "@/lib/societyBible";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
    }

    const { bible, lastAiTranscript } = (await req.json().catch(() => ({}))) as {
      bible?: SocietyBible;
      lastAiTranscript?: string;
    };

    if (!bible || !lastAiTranscript?.trim()) {
      return NextResponse.json({ error: "Missing bible or lastAiTranscript" }, { status: 400 });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const chat = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a canon-tracking assistant for a spoken worldbuilding game. Respond ONLY with the JSON object requested — no markdown, no extra text, all values in English.",
        },
        { role: "user", content: oobUpdatePrompt(bible, lastAiTranscript) },
      ],
      max_tokens: 512,
    });

    const raw = chat.choices[0]?.message?.content ?? "{}";
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "JSON parse failed", raw }, { status: 500 });
    }

    const asArr = (x: unknown) =>
      Array.isArray(x) ? (x as unknown[]).map(String).filter(Boolean) : [];

    return NextResponse.json({
      addCanon: asArr(parsed.addCanon).slice(0, 3),
      addOpenThreads: asArr(parsed.addOpenThreads).slice(0, 3),
      contradictionsFound: asArr(parsed.contradictionsFound).slice(0, 6),
      reconciliationOptions: asArr(parsed.reconciliationOptions).slice(0, 3),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? "Bible update failed") }, { status: 500 });
  }
}
