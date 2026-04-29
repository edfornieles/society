import { NextResponse } from "next/server";
import { usingR2 } from "@/lib/serverStorage";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    // In cloud deployments backed by R2, debug logs are best-effort no-op to
    // avoid filesystem dependencies.
    if (usingR2()) {
      return NextResponse.json({ ok: true });
    }

    const fs = await import("fs/promises");
    const path = await import("path");
    const logsDir = path.join(process.cwd(), "data", "logs");
    await fs.mkdir(logsDir, { recursive: true });
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ ok: false });

    const { sessionId, event, data } = body as {
      sessionId: string;
      event: string;
      data?: Record<string, unknown>;
    };

    const ts = new Date().toISOString();
    const lines: string[] = [`\n[${ts}] ${event}`];

    if (data) {
      for (const [k, v] of Object.entries(data)) {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        // Truncate very long strings (e.g. full system prompts) to keep logs readable
        const display = val.length > 2000 ? val.slice(0, 2000) + "…(truncated)" : val;
        lines.push(`  ${k}: ${display}`);
      }
    }

    const entry = lines.join("\n") + "\n";
    const logFile = path.join(logsDir, `${sessionId ?? "unknown"}.log`);
    await fs.appendFile(logFile, entry, "utf-8");

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    // Never crash the game due to a logging failure
    return NextResponse.json({ ok: false, error: String(e?.message) });
  }
}
