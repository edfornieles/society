// OpenNext → Cloudflare adapter config. Uses the R2 bucket the live Worker
// already has bound (NEXT_INC_CACHE_R2_BUCKET → society-opennext-cache) for
// Next's incremental cache, matching the existing deployment's architecture.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
});
