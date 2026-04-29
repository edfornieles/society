import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";

type SessionRecord = Record<string, any>;

const r2Endpoint = process.env.R2_ENDPOINT?.trim() || "";
const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() || "";
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() || "";
const r2Bucket = (process.env.R2_BUCKET?.trim() || process.env.R2_BUCKET_NAME?.trim() || "");
const r2PublicBaseUrl = (
  process.env.R2_PUBLIC_BASE_URL?.trim() ||
  process.env.S3_API?.trim() ||
  ""
).replace(/\/+$/, "");

const hasR2 =
  Boolean(r2Endpoint) &&
  Boolean(r2AccessKeyId) &&
  Boolean(r2SecretAccessKey) &&
  Boolean(r2Bucket);

let s3Client: S3Client | null = null;

function getS3(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: "auto",
      endpoint: r2Endpoint,
      credentials: {
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
      },
      forcePathStyle: true,
    });
  }
  return s3Client;
}

async function streamToString(body: any): Promise<string> {
  if (!body) return "";
  if (typeof body.transformToString === "function") return body.transformToString();
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const total = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return total.toString("utf-8");
}

async function localPathJoin(...parts: string[]): Promise<string> {
  const path = await import("path");
  return path.join(...parts);
}

async function ensureLocalSessionDir(): Promise<string> {
  const cwd = process.cwd();
  const fs = await import("fs/promises");
  const dir = await localPathJoin(cwd, "data", "sessions");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function usingR2(): boolean {
  return hasR2;
}

export function publicUrlForKey(key: string): string | null {
  if (!r2PublicBaseUrl) return null;
  return `${r2PublicBaseUrl}/${key.replace(/^\/+/, "")}`;
}

export async function listSessionsFromStorage(): Promise<Array<{ id: string; title: string; createdAt: number; updatedAt: number }>> {
  if (!hasR2) {
    const fs = await import("fs/promises");
    const sessionsDir = await ensureLocalSessionDir();
    const files = await fs.readdir(sessionsDir);
    const sessions = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          try {
            const raw = await fs.readFile(await localPathJoin(sessionsDir, f), "utf-8");
            const data = JSON.parse(raw);
            return {
              id: String(data.id ?? ""),
              title: String(data.title ?? data.id ?? ""),
              createdAt: Number(data.createdAt ?? 0),
              updatedAt: Number(data.updatedAt ?? data.createdAt ?? 0),
            };
          } catch {
            return null;
          }
        })
    );
    return sessions
      .filter(Boolean)
      .sort((a, b) => (b!.updatedAt ?? 0) - (a!.updatedAt ?? 0)) as Array<{
        id: string;
        title: string;
        createdAt: number;
        updatedAt: number;
      }>;
  }

  const s3 = getS3();
  const out = await s3.send(
    new ListObjectsV2Command({
      Bucket: r2Bucket,
      Prefix: "sessions/",
    })
  );
  const keys = (out.Contents ?? [])
    .map((c) => c.Key || "")
    .filter((k) => k.endsWith(".json"));

  const rows = await Promise.all(
    keys.map(async (key) => {
      try {
        const obj = await s3.send(
          new GetObjectCommand({
            Bucket: r2Bucket,
            Key: key,
          })
        );
        const raw = await streamToString(obj.Body);
        const data = JSON.parse(raw);
        return {
          id: String(data.id ?? ""),
          title: String(data.title ?? data.id ?? ""),
          createdAt: Number(data.createdAt ?? 0),
          updatedAt: Number(data.updatedAt ?? data.createdAt ?? 0),
        };
      } catch {
        return null;
      }
    })
  );

  return rows
    .filter(Boolean)
    .sort((a, b) => (b!.updatedAt ?? 0) - (a!.updatedAt ?? 0)) as Array<{
      id: string;
      title: string;
      createdAt: number;
      updatedAt: number;
    }>;
}

export async function getSessionFromStorage(id: string): Promise<SessionRecord | null> {
  if (!hasR2) {
    try {
      const fs = await import("fs/promises");
      const sessionsDir = await ensureLocalSessionDir();
      const raw = await fs.readFile(await localPathJoin(sessionsDir, `${id}.json`), "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  try {
    const s3 = getS3();
    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: r2Bucket,
        Key: `sessions/${id}.json`,
      })
    );
    const raw = await streamToString(obj.Body);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function putSessionToStorage(data: SessionRecord): Promise<void> {
  const id = String(data.id ?? "").trim();
  if (!id) throw new Error("Missing session id");

  const title = String(data.title ?? "Untitled Society");
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
  const md = [
    `# ${title}`,
    `**Session ID**: ${id}`,
    `**Created**: ${created}  |  **Last saved**: ${updated}`,
    coreValue ? `\n## The most important thing in this society\n> ${coreValue}` : "",
    canonLines.length ? `\n## Canon\n${canonLines.join("\n")}` : "",
    openThreads.length ? `\n## Open threads\n${openThreads.join("\n")}` : "",
    imageLines.length ? `\n## Images\n${imageLines.join("\n\n")}` : "",
    data.summary ? `\n## Session summary\n${data.summary}` : "",
    data.finalRecordText ? `\n## Final record\n${data.finalRecordText}` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  if (!hasR2) {
    const fs = await import("fs/promises");
    const sessionsDir = await ensureLocalSessionDir();
    await fs.writeFile(await localPathJoin(sessionsDir, `${id}.json`), JSON.stringify(data, null, 2), "utf-8");
    await fs.writeFile(await localPathJoin(sessionsDir, `${id}.md`), md, "utf-8");
    return;
  }

  const s3 = getS3();
  await s3.send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: `sessions/${id}.json`,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json; charset=utf-8",
    })
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: `sessions/${id}.md`,
      Body: md,
      ContentType: "text/markdown; charset=utf-8",
    })
  );
}

export async function deleteSessionFromStorage(id: string): Promise<void> {
  if (!hasR2) {
    const fs = await import("fs/promises");
    const sessionsDir = await ensureLocalSessionDir();
    await fs.unlink(await localPathJoin(sessionsDir, `${id}.json`)).catch(() => {});
    await fs.unlink(await localPathJoin(sessionsDir, `${id}.md`)).catch(() => {});
    await fs.rm(await localPathJoin(process.cwd(), "public", "game-images", id), { recursive: true, force: true }).catch(() => {});
    return;
  }

  const s3 = getS3();
  await s3.send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: `sessions/${id}.json` })).catch(() => {});
  await s3.send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: `sessions/${id}.md` })).catch(() => {});

  const listed = await s3.send(
    new ListObjectsV2Command({
      Bucket: r2Bucket,
      Prefix: `game-images/${id}/`,
    })
  );
  await Promise.all(
    (listed.Contents ?? [])
      .map((c) => c.Key)
      .filter(Boolean)
      .map((key) =>
        s3.send(
          new DeleteObjectCommand({
            Bucket: r2Bucket,
            Key: key!,
          })
        )
      )
  );
}

export async function putGeneratedImage(sessionId: string, pngBytes: Buffer, filename: string): Promise<string | null> {
  const key = `game-images/${sessionId}/${filename}`;

  if (!hasR2) {
    const fs = await import("fs/promises");
    const dir = await localPathJoin(process.cwd(), "public", "game-images", sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(await localPathJoin(dir, filename), pngBytes);
    return `/game-images/${sessionId}/${filename}`;
  }

  const s3 = getS3();
  await s3.send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: key,
      Body: pngBytes,
      ContentType: "image/png",
    })
  );

  return publicUrlForKey(key);
}

