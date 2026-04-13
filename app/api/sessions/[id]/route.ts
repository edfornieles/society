import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export const runtime = "nodejs";

const SESSIONS_DIR = path.join(process.cwd(), "data", "sessions");

/** GET /api/sessions/[id] — fetch a single full session record */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const filePath = path.join(SESSIONS_DIR, `${id}.json`);
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

/** DELETE /api/sessions/[id] — remove a session and its images */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const filePath = path.join(SESSIONS_DIR, `${id}.json`);
    await fs.unlink(filePath).catch(() => {});

    // Remove the session's image folder if it exists
    const imageDir = path.join(process.cwd(), "public", "game-images", id);
    await fs.rm(imageDir, { recursive: true, force: true }).catch(() => {});

    // Remove the human-readable markdown transcript if it exists
    const mdPath = path.join(SESSIONS_DIR, `${id}.md`);
    await fs.unlink(mdPath).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message) }, { status: 500 });
  }
}
