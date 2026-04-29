import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export const runtime = "nodejs";

const SESSIONS_DIR = path.join(process.cwd(), "data", "sessions");

/** Build a human-readable markdown document from a saved session record. */
function buildMarkdown(data: any): string {
  const title = data.title ?? "Untitled Society";
  const created = data.createdAt ? new Date(data.createdAt).toLocaleString() : "unknown";
  const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString() : created;
  const coreValue = data.bible?.canon?.coreValues?.[0] ?? "";

  const canonLines: string[] = (data.bible?.changelog ?? [])
    .slice()
    .sort((a: any, b: any) => (a.turn ?? 0) - (b.turn ?? 0))
    .map((c: any) => `- ${c.entry ?? ""}`)
    .filter((l: string) => l.length > 2);

  const openThreads: string[] = (data.bible?.openThreads ?? []).map((t: string) => `- ${t}`);

  const images: any[] = data.images ?? [];
  const imageLines = images.map((img: any, i: number) => {
    const src = img.imagePath ? img.imagePath : "(no path saved)";
    return `### Image ${i + 1}: ${img.title ?? "Scene"}\n- **Caption**: ${img.caption ?? ""}\n- **File**: ${src}\n- **Generated**: ${img.at ?? ""}`;
  });

  const sections: string[] = [
    `# ${title}`,
    `**Session ID**: ${data.id}`,
    `**Created**: ${created}  |  **Last saved**: ${updated}`,
    coreValue ? `\n## The most important thing in this society\n> ${coreValue}` : "",
    canonLines.length ? `\n## Canon\n${canonLines.join("\n")}` : "",
    openThreads.length ? `\n## Open threads\n${openThreads.join("\n")}` : "",
    imageLines.length ? `\n## Images\n${imageLines.join("\n\n")}` : "",
    data.summary ? `\n## Session summary\n${data.summary}` : "",
    data.finalRecordText ? `\n## Final record\n${data.finalRecordText}` : "",
  ];

  return sections.filter(Boolean).join("\n") + "\n";
}

async function ensureDir() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

/** GET /api/sessions — list all saved sessions (id + title + timestamps only) */
export async function GET() {
  try {
    await ensureDir();
    const files = await fs.readdir(SESSIONS_DIR);
    const sessions = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          try {
            const raw = await fs.readFile(path.join(SESSIONS_DIR, f), "utf-8");
            const data = JSON.parse(raw);
            return {
              id: data.id,
              title: data.title ?? data.id,
              createdAt: data.createdAt ?? 0,
              updatedAt: data.updatedAt ?? data.createdAt ?? 0,
            };
          } catch {
            return null;
          }
        })
    );
    const valid = sessions
      .filter(Boolean)
      .sort((a, b) => (b!.updatedAt ?? 0) - (a!.updatedAt ?? 0));
    return NextResponse.json(valid);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message) }, { status: 500 });
  }
}

/** POST /api/sessions — upsert a full session record */
export async function POST(req: Request) {
  try {
    await ensureDir();
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

    const filePath = path.join(SESSIONS_DIR, `${body.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(sanitized, null, 2), "utf-8");

    // Write a human-readable markdown file alongside the JSON.
    const mdPath = path.join(SESSIONS_DIR, `${body.id}.md`);
    await fs.writeFile(mdPath, buildMarkdown(sanitized), "utf-8").catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message) }, { status: 500 });
  }
}
