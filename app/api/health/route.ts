import { NextResponse } from "next/server";

/** GET /api/health — no deps; use to verify the Next server is up. */
export async function GET() {
  return NextResponse.json({ ok: true, at: new Date().toISOString() });
}
