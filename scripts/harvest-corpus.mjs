// Harvest the COMPLETE image corpus from R2 — every session (legacy +
// per-user scoped), every generated image, with the exact generation prompt
// that produced it — into a training-ready folder:
//
//   ~/titles_training_set/full-corpus/
//     images/<session-slug>-NN.png
//     manifest.csv   (file,session_id,session_title,image_title,caption,created_at,prompt)
//     manifest.json  (same rows, lossless)
//
// Run: node scripts/harvest-corpus.mjs   (needs .env.local R2 creds)

import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- env ---------------------------------------------------------------
const envFile = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
const env = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const s3 = new S3Client({
  region: "auto",
  endpoint: env.R2_ENDPOINT,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  forcePathStyle: true,
});
const BUCKET = env.R2_BUCKET;

const OUT = path.join(os.homedir(), "titles_training_set", "full-corpus");
const IMG_DIR = path.join(OUT, "images");
fs.mkdirSync(IMG_DIR, { recursive: true });

// --- helpers -----------------------------------------------------------
async function listAll(prefix) {
  const keys = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) keys.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function getBuffer(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await r.Body.transformToByteArray());
}

const slug = (s) =>
  String(s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "untitled";

// --- gather session records (legacy + every user scope) -----------------
const sessionKeys = [];
for (const k of await listAll("sessions/")) if (k.endsWith(".json")) sessionKeys.push(k);
for (const k of await listAll("u/")) if (/^u\/[^/]+\/sessions\/.+\.json$/.test(k)) sessionKeys.push(k);
console.log(`Found ${sessionKeys.length} session records`);

const rows = [];
const seenImageKeys = new Set();
let failed = 0;

for (const key of sessionKeys) {
  let rec;
  try {
    rec = JSON.parse((await getBuffer(key)).toString("utf-8"));
  } catch {
    console.warn(`  ! unreadable session ${key}`);
    continue;
  }
  const sessionTitle = String(rec.title ?? rec.name ?? "").trim();
  const sessionId = String(rec.id ?? path.basename(key, ".json"));
  const images = Array.isArray(rec.images) ? rec.images : [];
  let n = 0;
  for (const img of images) {
    // imagePath is stored as the media URL path (optionally basePath-prefixed);
    // the R2 key is everything after "/api/media/".
    const imgKey = String(img.imagePath ?? "").replace(/^.*?\/api\/media\//, "").replace(/^\/+/, "");
    if (!imgKey || seenImageKeys.has(imgKey)) continue;
    seenImageKeys.add(imgKey);
    n++;
    const file = `${slug(sessionTitle || sessionId)}-${sessionId.slice(0, 8)}-${String(n).padStart(2, "0")}.png`;
    try {
      const bytes = await getBuffer(imgKey);
      fs.writeFileSync(path.join(IMG_DIR, file), bytes);
      rows.push({
        file,
        session_id: sessionId,
        session_title: sessionTitle,
        image_title: String(img.title ?? ""),
        caption: String(img.caption ?? ""),
        created_at: img.at ? new Date(img.at).toISOString() : "",
        prompt: String(img.promptUsed ?? ""),
      });
    } catch {
      failed++;
      console.warn(`  ! failed image ${imgKey}`);
    }
  }
  if (n) console.log(`  ${sessionTitle || sessionId}: ${n} images`);
}

// --- manifests -----------------------------------------------------------
const csvEsc = (s) => `"${String(s).replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
const header = ["file", "session_id", "session_title", "image_title", "caption", "created_at", "prompt"];
const csv = [header.join(",")]
  .concat(rows.map((r) => header.map((h) => csvEsc(r[h])).join(",")))
  .join("\n");
fs.writeFileSync(path.join(OUT, "manifest.csv"), csv);
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(rows, null, 2));

console.log(`\nDone: ${rows.length} images (${failed} failed) → ${OUT}`);
