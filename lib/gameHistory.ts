import type { SocietyBible } from "./societyBible";
import type { GeneratedImage } from "@/app/components/ImageStrip";

export type SavedGame = {
  id: string;
  createdAt: number;
  title?: string;
  finalRecordText?: string;
  bible: SocietyBible;
  images: GeneratedImage[];
};

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
  db.close();
  return rows
    .map((g) => ({ id: g.id, createdAt: g.createdAt, title: g.title }))
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


