import { getMediaObject } from "@/lib/serverStorage";

export const runtime = "nodejs";

/**
 * GET /api/media/<key> — stream a stored media object (generated images).
 * Serves identically from R2 or the local dev filesystem, so image URLs work
 * in every environment without needing a public bucket.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const key = (path ?? []).join("/");
  if (!key) {
    return new Response("Not found", { status: 404 });
  }

  const obj = await getMediaObject(key);
  if (!obj) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(obj.body), {
    status: 200,
    headers: {
      "Content-Type": obj.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
