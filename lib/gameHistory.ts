import type { SocietyBible } from "./societyBible";
import { createEmptyBible } from "./societyBible";
import { extractCoreTopicPhrase, normalizeCoreValueUtterance } from "./coreValueNormalize";
import type { GeneratedImage } from "@/lib/generatedImage";

export type SavedGame = {
  id: string;
  createdAt: number;
  updatedAt?: number;
  title?: string;
  titleIsCustom?: boolean;
  finalRecordText?: string;
  summary?: string;
  aiMemory?: {
    coreChoice: string;
    canonHighlights: string[];
    openThreads: string[];
    imageCaptions: string[];
  };
  bible: SocietyBible;
  images: GeneratedImage[];
};

function cleanCoreChoice(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const collapsed = extractCoreTopicPhrase(normalizeCoreValueUtterance(cleaned));
  const lowered = collapsed.toLowerCase();
  const genericStarters = [
    "the society",
    "every",
    "dogs are",
    "agriculture is",
    "armor making is",
    "fashion shapes",
    "participants have started",
  ];
  for (const starter of genericStarters) {
    if (lowered.startsWith(starter)) {
      return collapsed
        .slice(starter.length)
        .replace(/^(\s+is|\s+are|\s+being|\s+places|\s+values|\s+worships)\b/i, "")
        .replace(/^[^a-z0-9]+/i, "")
        .trim();
    }
  }
  return collapsed;
}

function deriveCoreChoiceFromSummary(summary?: string): string {
  if (!summary) return "";
  const lines = summary.split("\n").map((l) => l.trim());
  let inCanon = false;
  for (const line of lines) {
    if (/^###\s+Canon/i.test(line)) {
      inCanon = true;
      continue;
    }
    if (inCanon && line.startsWith("- ")) {
      return cleanCoreChoice(line.replace(/^-\s+/, "").trim());
    }
  }
  // Fallback: first bullet anywhere
  const firstBullet = lines.find((l) => l.startsWith("- "));
  return firstBullet ? cleanCoreChoice(firstBullet.replace(/^-\s+/, "").trim()) : "";
}

function deriveCoreChoice(bible: SocietyBible, summary?: string): string {
  const core0 = cleanCoreChoice(String(bible?.canon?.coreValues?.[0] ?? "").trim());
  if (core0) return core0;
  const genericPattern = /started a session|session started|participants have started|society places|society values|central value|core value|central core|shapes all aspects|all other aspects|emerge/i;
  const firstCanon = bible.changelog
    .slice()
    .sort((a, b) => a.turn - b.turn)
    .map((c) => String(c.entry ?? "").trim())
    .find((entry) => entry && !genericPattern.test(entry));
  const fromSummary = deriveCoreChoiceFromSummary(summary);
  return cleanCoreChoice(String(firstCanon ?? fromSummary ?? "").trim());
}

function formatSessionTitle(coreChoice: string): string {
  const cleaned = cleanCoreChoice(coreChoice);
  if (!cleaned) return "";
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "of",
    "and",
    "to",
    "in",
    "on",
    "for",
    "with",
    "by",
    "from",
    "about",
    "is",
    "are",
    "be",
    "being",
    "through",
  ]);
  const words = cleaned
    .split(" ")
    .map((w) => w.trim())
    .filter(Boolean);
  const keywords = words.filter((w) => !stopWords.has(w.toLowerCase()));
  const picked = (keywords.length ? keywords : words).slice(0, 3);
  return picked.join(" ");
}

function isGenericTitle(title?: string): boolean {
  if (!title) return true;
  return /society\s+\d{4}|participants have started|session started|the society/i.test(title);
}

export function normalizeSavedGame(game: SavedGame): { game: SavedGame; changed: boolean } {
  const core = deriveCoreChoice(game.bible, game.summary);
  let changed = false;
  const next = structuredClone(game);
  const formatted = formatSessionTitle(core);

  if (core && !next.bible?.canon?.coreValues?.[0]) {
    if (!next.bible) {
      return { game, changed: false };
    }
    if (!next.bible.canon) {
      next.bible.canon = createEmptyBible().canon;
    }
    if (!Array.isArray(next.bible.canon.coreValues)) {
      next.bible.canon.coreValues = [];
    }
    next.bible.canon.coreValues[0] = core;
    changed = true;
  }
  if (core && !next.titleIsCustom && formatted && (isGenericTitle(next.title) || next.title !== formatted)) {
    next.title = formatted;
    changed = true;
  }
  if (!next.createdAt || Number.isNaN(next.createdAt)) {
    next.createdAt = Date.now();
    changed = true;
  }
  const memory = buildAiMemory(next);
  const prev = next.aiMemory;
  const memoryChanged =
    !prev ||
    prev.coreChoice !== memory.coreChoice ||
    JSON.stringify(prev.canonHighlights) !== JSON.stringify(memory.canonHighlights) ||
    JSON.stringify(prev.openThreads) !== JSON.stringify(memory.openThreads) ||
    JSON.stringify(prev.imageCaptions) !== JSON.stringify(memory.imageCaptions);
  if (memoryChanged) {
    next.aiMemory = memory;
    changed = true;
  }
  if (!next.summary?.trim() && (memory.canonHighlights.length || memory.openThreads.length || memory.imageCaptions.length)) {
    next.summary = buildSummaryFromMemory(memory);
    changed = true;
  }
  if (!next.updatedAt) {
    next.updatedAt = next.createdAt;
    changed = true;
  }
  return { game: changed ? next : game, changed };
}

function buildAiMemory(game: SavedGame): NonNullable<SavedGame["aiMemory"]> {
  const coreChoice = deriveCoreChoice(game.bible, game.summary);
  const canonHighlights = game.bible.changelog
    .slice()
    .sort((a, b) => a.turn - b.turn)
    .slice(-12)
    .map((c) => String(c.entry ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const openThreads = game.bible.openThreads
    .slice(-8)
    .map((t) => String(t ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const imageCaptions = game.images
    .map((img) => String(img.caption || img.title || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-12);
  return { coreChoice, canonHighlights, openThreads, imageCaptions };
}

function buildSummaryFromMemory(memory: NonNullable<SavedGame["aiMemory"]>): string {
  const canon = memory.canonHighlights.slice(0, 8).map((line) => `- ${line}`).join("\n");
  const threads = memory.openThreads.slice(0, 6).map((line) => `- ${line}`).join("\n");
  const images = memory.imageCaptions.slice(0, 6).map((line) => `- ${line}`).join("\n");
  return [
    "## Summary so far",
    memory.coreChoice ? `\n### Core value\n- ${memory.coreChoice}` : "",
    canon ? `\n### Canon\n${canon}` : "",
    threads ? `\n### Open threads\n${threads}` : "",
    images ? `\n### Image notes\n${images}` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Server-side file storage via API routes.
// Sessions are stored as JSON files in data/sessions/{id}.json.
// When the game goes online, swap these fetch() calls for database calls.
// ---------------------------------------------------------------------------

const API_BASE = "/api/sessions";

export async function saveGame(game: SavedGame): Promise<void> {
  const existing = await getGame(game.id).catch(() => null);
  const normalized = normalizeSavedGame({
    ...game,
    createdAt: existing?.createdAt ?? game.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }).game;
  const r = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(normalized),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.warn("[saveGame]", r.status, detail);
    throw new Error(`saveGame failed: ${r.status} ${detail.slice(0, 200)}`);
  }
}

export async function listGames(): Promise<Pick<SavedGame, "id" | "createdAt" | "title">[]> {
  const r = await fetch(API_BASE);
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.warn("[listGames]", r.status, detail);
    return [];
  }
  const rows = (await r.json()) as { id: string; createdAt: number; title?: string }[];
  return rows.map((g) => ({
    id: g.id,
    createdAt: g.createdAt ?? 0,
    title: g.title,
  }));
}

export async function getGame(id: string): Promise<SavedGame | null> {
  const r = await fetch(`${API_BASE}/${id}`);
  if (!r.ok) return null;
  return r.json() as Promise<SavedGame>;
}

export async function deleteGame(id: string): Promise<void> {
  await fetch(`${API_BASE}/${id}`, { method: "DELETE" });
}


