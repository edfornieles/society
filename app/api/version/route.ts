import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** GET /api/version — the server's build stamp. The client compares this with
 *  its own baked NEXT_PUBLIC_BUILD_AT: a mismatch means the tab is running
 *  old JS from before a deploy and should be reloaded. */
export async function GET() {
  return NextResponse.json(
    { buildAt: process.env.NEXT_PUBLIC_BUILD_AT ?? "unknown" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
