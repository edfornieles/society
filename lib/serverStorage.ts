import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";

type SessionRecord = Record<string, any>;

const r2Endpoint = process.env.R2_ENDPOINT?.trim() || "";
const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() || "";
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() || "";
const r2Bucket = process.env.R2_BUCKET?.trim() || process.env.R2_BUCKET_NAME?.trim() || "";

// Storage driver selection. R2 is the intended driver for both local dev and
// production (dev/prod parity). Local filesystem is an EXPLICIT, LOUD fallback
// for offline dev only — it is NOT durable on serverless hosts.
const r2Vars = { R2_ENDPOINT: r2Endpoint, R2_ACCESS_KEY_ID: r2AccessKeyId, R2_SECRET_ACCESS_KEY: r2SecretAccessKey, R2_BUCKET: r2Bucket };
const r2Present = Object.values(r2Vars).filter(Boolean).length;
const hasR2 = r2Present === 4;
const partialR2 = r2Present > 0 && r2Present < 4;

// Allow forcing local mode for offline dev: STORAGE_DRIVER=local
const forceLocal = (process.env.STORAGE_DRIVER?.trim().toLowerCase() || "") === "local";
const driver: "r2" | "local" = hasR2 && !forceLocal ? "r2" : "local";

// Surface misconfiguration loudly at module load instead of silently losing data.
if (partialR2 && !forceLocal) {
  const missing = Object.entries(r2Vars).filter(([, v]) => !v).map(([k]) => k);
  console.error(
    `[storage] R2 is PARTIALLY configured — missing: ${missing.join(", ")}. ` +
      `Falling back to LOCAL filesystem storage, which is NOT durable on serverless. ` +
      `Set all of R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (or STORAGE_DRIVER=local to silence this).`
  );
} else if (driver === "local") {
  console.warn(
    `[storage] Using LOCAL filesystem storage (data/). Sessions and images will NOT persist across serverless cold starts. ` +
      `Configure R2 (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET) for durable storage.`
  );
}

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

async function streamToBuffer(body: any): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

async function streamToString(body: any): Promise<string> {
  if (!body) return "";
  if (typeof body.transformToString === "function") return body.transformToString();
  return (await streamToBuffer(body)).toString("utf-8");
}

async function localPathJoin(...parts: string[]): Promise<string> {
  const path = await import("path");
  return path.join(...parts);
}

async function ensureLocalDir(...parts: string[]): Promise<string> {
  const fs = await import("fs/promises");
  const dir = await localPathJoin(process.cwd(), ...parts);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Human-readable storage status for /api/health and startup diagnostics. */
export function getStorageStatus(): {
  driver: "r2" | "local";
  durable: boolean;
  bucket: string | null;
  partialR2: boolean;
} {
  return {
    driver,
    durable: driver === "r2",
    bucket: driver === "r2" ? r2Bucket : null,
    partialR2,
  };
}

export function usingR2(): boolean {
  return driver === "r2";
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  json: "application/json; charset=utf-8",
};

function contentTypeFor(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() || "";
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// Per-user session scoping (anonymous, no login). A client-generated id (from
// localStorage, sent as the x-society-cid header) scopes each browser's saved
// games under u/{cid}/ so users only ever see + list their OWN games. This
// isolates players AND fixes the load problem behind the recurring Error 1102:
// a list is now just one user's handful of games, not all sessions globally.
// An empty cid falls back to the legacy flat sessions/ prefix (backward compat
// for storage-blocked browsers, and where the pre-scoping global games live).
function sanitizeCid(cid: string | undefined | null): string {
  return String(cid || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}
function sessionJsonKey(cid: string, id: string): string {
  return cid ? `u/${cid}/${id}.json` : `sessions/${id}.json`;
}
function sessionMdKey(cid: string, id: string): string {
  return cid ? `u/${cid}/${id}.md` : `sessions/${id}.md`;
}
function sessionPrefix(cid: string): string {
  return cid ? `u/${cid}/` : "sessions/";
}
async function sessionsLocalDir(cid: string): Promise<string> {
  return cid ? ensureLocalDir("data", "sessions", "u", cid) : ensureLocalDir("data", "sessions");
}

export async function listSessionsFromStorage(cidRaw = ""): Promise<Array<{ id: string; title: string; createdAt: number; updatedAt: number }>> {
  const cid = sanitizeCid(cidRaw);
  if (driver === "local") {
    const fs = await import("fs/promises");
    const sessionsDir = await sessionsLocalDir(cid);
    const files = await fs.readdir(sessionsDir).catch(() => [] as string[]);
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
      Prefix: sessionPrefix(cid),
      MaxKeys: 1000,
    })
  );
  // Bound the fan-out: this fetches + JSON-parses each session's FULL record
  // (22-45KB) just to read its title/date, so the memory + subrequest cost
  // grows with session count and can push a Worker isolate over its resource
  // limit (Error 1102). Fetch bodies only for the most-recently-written N,
  // using R2's LastModified (from the list, no body needed) to pick them.
  const LIST_LIMIT = 40;
  const contents = (out.Contents ?? [])
    .filter((c) => (c.Key || "").endsWith(".json"))
    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))
    .slice(0, LIST_LIMIT);
  const keys = contents.map((c) => c.Key || "");

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
      } catch (err) {
        console.error(`[storage] failed to read session ${key}:`, err);
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

export async function getSessionFromStorage(id: string, cidRaw = ""): Promise<SessionRecord | null> {
  const cid = sanitizeCid(cidRaw);
  if (driver === "local") {
    const fs = await import("fs/promises");
    // Scoped first, then legacy flat location — lets a returning player resume
    // a pre-scoping game (it migrates to their scope on next save).
    for (const dir of cid ? [await sessionsLocalDir(cid), await ensureLocalDir("data", "sessions")] : [await ensureLocalDir("data", "sessions")]) {
      try {
        const raw = await fs.readFile(await localPathJoin(dir, `${id}.json`), "utf-8");
        return JSON.parse(raw);
      } catch {
        // try next location
      }
    }
    return null;
  }
  const s3 = getS3();
  const keys = cid ? [sessionJsonKey(cid, id), `sessions/${id}.json`] : [`sessions/${id}.json`];
  for (const Key of keys) {
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: r2Bucket, Key }));
      return JSON.parse(await streamToString(obj.Body));
    } catch {
      // fall through to the next candidate (scoped miss -> legacy)
    }
  }
  return null;
}

function buildSessionMarkdown(data: SessionRecord): string {
  const id = String(data.id ?? "").trim();
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
  return [
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
}

export async function putSessionToStorage(data: SessionRecord, cidRaw = ""): Promise<void> {
  const id = String(data.id ?? "").trim();
  if (!id) throw new Error("Missing session id");
  const cid = sanitizeCid(cidRaw);

  const md = buildSessionMarkdown(data);

  if (driver === "local") {
    const fs = await import("fs/promises");
    const sessionsDir = await sessionsLocalDir(cid);
    await fs.writeFile(await localPathJoin(sessionsDir, `${id}.json`), JSON.stringify(data, null, 2), "utf-8");
    await fs.writeFile(await localPathJoin(sessionsDir, `${id}.md`), md, "utf-8");
    return;
  }

  const s3 = getS3();
  await s3.send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: sessionJsonKey(cid, id),
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json; charset=utf-8",
    })
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: sessionMdKey(cid, id),
      Body: md,
      ContentType: "text/markdown; charset=utf-8",
    })
  );
}

export async function deleteSessionFromStorage(id: string, cidRaw = ""): Promise<void> {
  const cid = sanitizeCid(cidRaw);
  if (driver === "local") {
    const fs = await import("fs/promises");
    const sessionsDir = await sessionsLocalDir(cid);
    await fs.unlink(await localPathJoin(sessionsDir, `${id}.json`)).catch(() => {});
    await fs.unlink(await localPathJoin(sessionsDir, `${id}.md`)).catch(() => {});
    await fs.rm(await localPathJoin(process.cwd(), "data", "media", "game-images", id), { recursive: true, force: true }).catch(() => {});
    return;
  }

  const s3 = getS3();
  await s3.send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: sessionJsonKey(cid, id) })).catch(() => {});
  await s3.send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: sessionMdKey(cid, id) })).catch(() => {});

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

/**
 * Persist a generated PNG and return an APP-RELATIVE media path that is served
 * back through /api/media/<key>. This works identically in R2 and local mode
 * and needs no public bucket. Returns null only if the write fails.
 */
export async function putGeneratedImage(sessionId: string, pngBytes: Buffer, filename: string): Promise<string | null> {
  const key = `game-images/${sessionId}/${filename}`;

  try {
    if (driver === "local") {
      const fs = await import("fs/promises");
      const dir = await ensureLocalDir("data", "media", "game-images", sessionId);
      await fs.writeFile(await localPathJoin(dir, filename), pngBytes);
      return `/api/media/${key}`;
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
    return `/api/media/${key}`;
  } catch (err) {
    console.error(`[storage] putGeneratedImage failed for ${key}:`, err);
    return null;
  }
}

/** Fetch a stored media object (image) by key, for the /api/media route. */
/** Telemetry batches for LIVE session monitoring: the client flushes small
 *  JSON event arrays here; R2 has no append, so each flush is one object at
 *  debug-logs/{sessionId}/{ts}.json. Read back merged via getTelemetry. */
export async function putTelemetryBatch(sessionId: string, events: unknown[]): Promise<void> {
  const ts = Date.now();
  if (driver === "local") {
    const fs = await import("fs/promises");
    const dir = await ensureLocalDir("data", "debug-logs", sessionId);
    await fs.writeFile(await localPathJoin(dir, `${ts}.json`), JSON.stringify(events), "utf-8");
    return;
  }
  const s3 = getS3();
  await s3.send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: `debug-logs/${sessionId}/${ts}.json`,
      Body: Buffer.from(JSON.stringify(events)),
      ContentType: "application/json; charset=utf-8",
    })
  );
}

export async function getTelemetry(sessionId: string, sinceMs: number): Promise<unknown[]> {
  // Hard cap on batch files fetched per call: a long session flushes a batch
  // every ~3s, so an unbounded fetch could fan out to thousands of R2
  // subrequests in ONE Worker invocation and blow the CPU/subrequest limit
  // (Error 1102). Only ever read the most recent MAX_BATCHES.
  const MAX_BATCHES = 120;
  const tsOf = (name: string) => Number(name.split("/").pop()?.replace(".json", "") ?? NaN);
  if (driver === "local") {
    const fs = await import("fs/promises");
    const dir = await ensureLocalDir("data", "debug-logs", sessionId);
    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith(".json") && tsOf(f) >= sinceMs)
      .sort()
      .slice(-MAX_BATCHES);
    const batches = await Promise.all(
      files.map(async (f) => {
        try {
          return JSON.parse(await fs.readFile(await localPathJoin(dir, f), "utf-8"));
        } catch {
          return [];
        }
      })
    );
    return batches.flat();
  }
  const s3 = getS3();
  const out = await s3.send(
    new ListObjectsV2Command({ Bucket: r2Bucket, Prefix: `debug-logs/${sessionId}/`, MaxKeys: 1000 })
  );
  const keys = (out.Contents ?? [])
    .map((c) => c.Key || "")
    .filter((k) => k.endsWith(".json") && tsOf(k) >= sinceMs)
    .sort()
    .slice(-MAX_BATCHES);
  const batches = await Promise.all(
    keys.map(async (key) => {
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: r2Bucket, Key: key }));
        return JSON.parse(await streamToString(obj.Body));
      } catch {
        return [];
      }
    })
  );
  return batches.flat();
}

export async function getMediaObject(key: string): Promise<{ body: Buffer; contentType: string } | null> {
  const cleanKey = key.replace(/^\/+/, "");
  // Guard against path traversal.
  if (cleanKey.includes("..")) return null;

  try {
    if (driver === "local") {
      const fs = await import("fs/promises");
      const filePath = await localPathJoin(process.cwd(), "data", "media", cleanKey);
      const body = await fs.readFile(filePath);
      return { body, contentType: contentTypeFor(cleanKey) };
    }

    const s3 = getS3();
    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: r2Bucket,
        Key: cleanKey,
      })
    );
    const body = await streamToBuffer(obj.Body);
    return { body, contentType: obj.ContentType || contentTypeFor(cleanKey) };
  } catch {
    return null;
  }
}
