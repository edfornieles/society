/** Saved / in-memory image metadata for a Society session. */
export type GeneratedImage = {
  /** Base64 PNG — kept in memory for immediate display. */
  b64?: string;
  /** App-relative URL that streams the saved PNG, e.g. /api/media/game-images/{sessionId}/{ts}.png */
  imagePath?: string | null;
  title: string;
  at: string;
  caption?: string;
  seedFacts?: string[];
  promptUsed?: string;
};
