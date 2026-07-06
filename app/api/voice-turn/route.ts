import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

/**
 * POST /api/voice-turn — same shape as /api/text-turn, but routed through
 * OpenRouter to an uncensored open-weight model instead of OpenAI. Used by
 * the local voice pipeline (Whisper STT -> this -> Pocket-TTS) specifically
 * because OpenAI's own moderation layer can't be relaxed via prompting for
 * genuinely dark fictional content — this swaps the model, not just the
 * prompt, to actually change what content gets through.
 */
export async function POST(req: Request) {
  try {
    if (!process.env.OPENROUTER_API_KEY) {
      return NextResponse.json({ error: "Missing OPENROUTER_API_KEY" }, { status: 500 });
    }

    const { instructions, json, history, stream, maxTokens } = (await req.json().catch(() => ({}))) as {
      instructions?: string;
      json?: boolean;
      history?: { role: "user" | "assistant"; content: string }[];
      stream?: boolean;
      maxTokens?: number;
    };

    if (!instructions || typeof instructions !== "string") {
      return NextResponse.json({ error: "Missing instructions" }, { status: 400 });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });
    // DeepSeek (default 2026-07-03): coherent like unmute.sh's Mistral-Small
    // while keeping the dark latitude Cydonia had. The prior Cydonia-24B (an
    // uncensored roleplay fine-tune) rambled, garbled tokens, and asked
    // multiple questions per turn — a bake-off through the identical prompts
    // showed DeepSeek fixed all of it. Override with OPENROUTER_MODEL.
    const model = process.env.OPENROUTER_MODEL?.trim() || "deepseek/deepseek-chat";

    // Real turn-by-turn history (instead of re-deriving "what's been said" into
    // the system prompt each call) lets the model track the world the way any
    // chat model tracks context — the caller caps this to a rolling window.
    const historyMessages = Array.isArray(history)
      ? history
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
          .map((m) => ({ role: m.role, content: m.content.trim() }))
      : [];

    const messages = [{ role: "system" as const, content: instructions }, ...historyMessages];

    // Streaming path (spoken conversational turns): pipe token deltas straight
    // back to the client as plain-text chunks so it can start TTS on the first
    // sentence while the rest of the reply is still generating. This is the
    // single biggest latency win — audio starts after the first sentence, not
    // after the whole (potentially multi-second) completion.
    if (stream && !json) {
      // NOTE: OpenRouter's `provider: {sort: "latency"}` was tried here and
      // REVERTED — it favors fast-TTFT hosts that drop streams mid-generation
      // (observed live: replies truncated mid-sentence, spoken as ragged
      // half-questions). Default routing weights uptime; a stable stream is
      // worth more than ~300ms of first-token latency in a spoken turn.
      const upstreamStart = Date.now();
      const completion = await client.chat.completions.create({
        model,
        messages,
        // Conversational turns must stay SHORT for a real back-and-forth feel
        // (a 220-token reply is ~25s of speech = a monologue). The prompt asks
        // for ~30 words; this ceiling just stops a rambling model mid-flight.
        max_tokens: 100,
        stream: true,
      });
      const encoder = new TextEncoder();
      const rs = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const chunk of completion) {
              const delta = chunk.choices?.[0]?.delta?.content ?? "";
              if (delta) controller.enqueue(encoder.encode(delta));
            }
          } catch {
            // Upstream hiccup mid-stream — close cleanly with whatever we sent.
          } finally {
            controller.close();
          }
        },
      });
      return new Response(rs, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          // Time until OpenRouter answered with response HEADERS (its own
          // provider handshake) — lets live debugging split "upstream is slow"
          // from "streaming is buffered" without redeploying instrumentation.
          "Server-Timing": `upstream;dur=${Date.now() - upstreamStart}`,
        },
      });
    }

    // Token budget: an explicit maxTokens (e.g. a spoken RECAP, which is a
    // multi-sentence chronicle, not a 2-line conversational turn) wins; else
    // JSON calls get room for their schema and a plain turn stays tight.
    const cap =
      Number.isFinite(maxTokens) && (maxTokens as number) > 0
        ? Math.min(1500, Math.floor(maxTokens as number))
        : json
        ? 900
        : 100;
    const completion = await client.chat.completions.create({
      model,
      messages,
      max_tokens: cap,
      // Open-weight models via OpenRouter don't all honor strict JSON mode as
      // reliably as OpenAI's — callers already fall back through safeJsonParse
      // when this doesn't come back perfectly structured.
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
    const message = String(e?.message ?? "Voice turn failed");
    return NextResponse.json({ error: message }, { status });
  }
}
