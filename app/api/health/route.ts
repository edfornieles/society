import { NextResponse } from "next/server";
import { getStorageStatus } from "@/lib/serverStorage";

export const runtime = "nodejs";

/**
 * GET /api/health — verify the server is up and report the active storage
 * driver so a non-durable (local) fallback is visible instead of silent.
 */
export async function GET() {
  const storage = getStorageStatus();
  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    storage,
    openaiKey: Boolean(process.env.OPENAI_API_KEY),
  });
}
