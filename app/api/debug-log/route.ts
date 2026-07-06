import { NextResponse } from "next/server";
import { putTelemetryBatch, getTelemetry } from "@/lib/serverStorage";

export const runtime = "nodejs";

/**
 * POST /api/debug-log — client-side telemetry for LIVE session monitoring.
 * The voice console batches events (turn timings, TTS underruns, echo
 * discards, errors) and flushes them here; they land in storage (R2 in prod)
 * under debug-logs/{sessionId}/, so a session can be watched remotely WHILE
 * it is being played via the GET below. Best-effort: never breaks the game.
 *
 * Accepts the batched shape { sessionId, events: [...] } and the legacy
 * single-event shape { sessionId, event, data }.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { sessionId?: string; events?: unknown[]; event?: string; data?: Record<string, unknown> }
      | null;
    if (!body) return NextResponse.json({ ok: false });

    const sessionId = String(body.sessionId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "unknown";
    const events = Array.isArray(body.events)
      ? body.events.slice(0, 100)
      : body.event
      ? [{ at: Date.now(), type: String(body.event), ...(body.data ?? {}) }]
      : [];
    if (!events.length) return NextResponse.json({ ok: true });

    await putTelemetryBatch(sessionId, events);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    // Never crash the game due to a logging failure
    return NextResponse.json({ ok: false, error: String(e?.message) });
  }
}

/** GET /api/debug-log?sessionId=X&since=<ms> — read a session's telemetry. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sessionId = String(url.searchParams.get("sessionId") || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
    const since = Number(url.searchParams.get("since") || 0);
    const events = await getTelemetry(sessionId, Number.isFinite(since) ? since : 0);
    return NextResponse.json({ sessionId, count: events.length, events });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? "telemetry read failed") }, { status: 500 });
  }
}
