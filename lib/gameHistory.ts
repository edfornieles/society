import type { SocietyBible } from "./societyBible";
import type { GeneratedImage } from "@/app/components/ImageStrip";

export type SavedGame = {
  id: string;
  createdAt: number;
  title?: string;
  titleIsCustom?: boolean;
  finalRecordText?: string;
  summary?: string;
  bible: SocietyBible;
  images: GeneratedImage[];
};

function cleanCoreChoice(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const lowered = cleaned.toLowerCase();
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
      return cleaned
        .slice(starter.length)
        .replace(/^(\s+is|\s+are|\s+being|\s+places|\s+values|\s+worships)\b/i, "")
        .replace(/^[^a-z0-9]+/i, "")
        .trim();
    }
  }
  return cleaned;
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
  if (!core) return { game, changed: false };
  const formatted = formatSessionTitle(core);
  let changed = false;
  const next = structuredClone(game);
  if (!next.bible?.canon?.coreValues?.[0]) {
    next.bible.canon.coreValues[0] = core;
    changed = true;
  }
  if (!next.titleIsCustom && formatted && (isGenericTitle(next.title) || next.title !== formatted)) {
    next.title = formatted;
    changed = true;
  }
  return { game: changed ? next : game, changed };
}

const DB_NAME = "society";
const DB_VERSION = 1;
const STORE = "games";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveGame(game: SavedGame): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(game);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function listGames(): Promise<Pick<SavedGame, "id" | "createdAt" | "title">[]> {
  const db = await openDb();
  const rows = await new Promise<SavedGame[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as SavedGame[]);
    req.onerror = () => reject(req.error);
  });
  // Migrate titles to the new format when possible.
  const updates = rows
    .map((g) => {
      const normalized = normalizeSavedGame(g);
      return normalized.changed ? normalized.game : null;
    })
    .filter(Boolean) as SavedGame[];
  if (updates.length) {
    for (const g of updates) {
      await saveGame(g);
    }
  }
  db.close();
  const latest = updates.length ? rows.map((g) => updates.find((u) => u.id === g.id) ?? g) : rows;
  return latest
    .map((g) => {
      const core = deriveCoreChoice(g.bible, g.summary);
      const formatted = formatSessionTitle(core);
      const title = g.titleIsCustom ? g.title : formatted || g.title;
      return { id: g.id, createdAt: g.createdAt, title };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getGame(id: string): Promise<SavedGame | null> {
  const db = await openDb();
  const row = await new Promise<SavedGame | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve((req.result as SavedGame) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return row;
}

export async function deleteGame(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}


