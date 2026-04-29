import { NextResponse } from "next/server";
import { listSessionsFromStorage, putSessionToStorage } from "@/lib/serverStorage";

export const runtime = "nodejs";

/** GET /api/sessions — list all saved sessions (id + title + timestamps only) */
export async function GET() {
  try {
    const sessions = await listSessionsFromStorage();
    return NextResponse.json(sessions);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message) }, { status: 500 });
  }
}

/** POST /api/sessions — upsert a full session record */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body?.id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    // Strip large base64 blobs from the JSON — images are saved as PNGs separately.
    // We store imagePath instead so the file stays readable.
    const sanitized = {
      ...body,
      images: (body.images ?? []).map((img: any) => ({
        title: img.title,
        caption: img.caption,
        seedFacts: img.seedFacts,
        promptUsed: img.promptUsed,
        at: img.at,
        imagePath: img.imagePath ?? null,
        ...(img.imagePath ? {} : { b64: img.b64 }),
      })),
      updatedAt: Date.now(),
    };

    await putSessionToStorage(sanitized);

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message) }, { status: 500 });
  }
}
