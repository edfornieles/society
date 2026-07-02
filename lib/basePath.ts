/**
 * Deployment path prefix. Empty for local dev; set to "/society" in production
 * where the app is served under edfornieles.com/society.
 *
 * next.config.mjs reads the same env var for Next's `basePath`, which auto-
 * prefixes framework assets (/_next) and the router. But manual fetch() calls
 * and plain <img src="/..."> are NOT auto-prefixed by Next — use withBase() for
 * those so every path resolves correctly under the prefix.
 */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");

/** Prefix an app-absolute path (starting with "/") with the deployment base path. */
export function withBase(path: string): string {
  if (!path) return path;
  // Leave data URIs and absolute URLs untouched.
  if (/^(data:|https?:|blob:)/i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${normalized}`;
}

/**
 * Resolve a stored image path to a loadable URL.
 * - Absolute URLs / data URIs pass through unchanged.
 * - Current paths (/api/media/...) get the base-path prefix.
 * - Legacy paths (/game-images/...) — saved before images were served through
 *   the app — are rerouted to /api/media, which reads the same R2 key. This
 *   makes older sessions' backgrounds display again.
 */
export function mediaSrc(path?: string | null): string {
  if (!path) return "";
  if (/^(data:|https?:|blob:)/i.test(path)) return path;
  const rerouted = path.startsWith("/game-images/") ? `/api/media${path}` : path;
  return withBase(rerouted);
}
