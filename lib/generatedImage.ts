/** Saved / in-memory image metadata for a Society session. */
export type GeneratedImage = {
  /** Base64 PNG — kept in memory for immediate display. */
  b64?: string;
  /** Server-relative URL to the saved PNG file, e.g. /game-images/{sessionId}/{ts}.png */
  imagePath?: string;
  title: string;
  at: string;
  caption?: string;
  seedFacts?: string[];
  promptUsed?: string;
};
