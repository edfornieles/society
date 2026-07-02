import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

/**
 * POST /api/text-turn — cheap text-chat equivalent of a realtime response.create.
 * The caller passes a fully self-contained "instructions" string (same ones used
 * for voice turns) and gets back the model's reply as plain text. Used by the
 * text dev console so gameplay/prompt iteration doesn't burn realtime-voice cost.
 */
export async function POST(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
    }

    const { instructions, json, history } = (await req.json().catch(() => ({}))) as {
      instructions?: string;
      json?: boolean;
      history?: { role: "user" | "assistant"; content: string }[];
    };

    if (!instructions || typeof instructions !== "string") {
      return NextResponse.json({ error: "Missing instructions" }, { status: 400 });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_TEXT_MODEL?.trim() || "gpt-4o-mini";

    const historyMessages = Array.isArray(history)
      ? history
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
          .map((m) => ({ role: m.role, content: m.content.trim() }))
      : [];

    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: "system", content: instructions }, ...historyMessages],
      max_tokens: 700,
      ...(json ? { response_format: { type: "json_object" as const } } : {}),
    });

    const text = completion.choices[0]?.message?.content ?? "";
    if (!text) {
      return NextResponse.json({ error: "No text returned" }, { status: 500 });
    }

    return NextResponse.json({ text });
  } catch (e: any) {
    const statusRaw = Number(e?.status ?? e?.statusCode ?? 500);
    const status = statusRaw >= 400 && statusRaw < 600 ? statusRaw : 500;
    const message = String(e?.message ?? "Text turn failed");
    return NextResponse.json({ error: message }, { status });
  }
}
