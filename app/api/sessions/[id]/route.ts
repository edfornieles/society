import { NextResponse } from "next/server";
import { deleteSessionFromStorage, getSessionFromStorage } from "@/lib/serverStorage";

export const runtime = "nodejs";

/** GET /api/sessions/[id] — fetch a single full session record */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const data = await getSessionFromStorage(id);
    if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

/** DELETE /api/sessions/[id] — remove a session and its images */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteSessionFromStorage(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message) }, { status: 500 });
  }
}
