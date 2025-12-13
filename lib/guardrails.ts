import type { SocietyBible } from "./societyBible";

export type BibleUpdate = {
  addCanon: string[];
  addOpenThreads: string[];
  contradictionsFound: string[];
  reconciliationOptions: string[];
};

export function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function sanitizeUpdate(u: Partial<BibleUpdate> | null): BibleUpdate | null {
  if (!u) return null;
  const asArr = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
  const addCanon = asArr(u.addCanon).slice(0, 3);
  const addOpenThreads = asArr(u.addOpenThreads).slice(0, 3);
  const contradictionsFound = asArr(u.contradictionsFound).slice(0, 6);
  const reconciliationOptions = asArr(u.reconciliationOptions).slice(0, 3);
  return { addCanon, addOpenThreads, contradictionsFound, reconciliationOptions };
}

// Super-light “consistency gate” placeholder.
// You can deepen this later by comparing against structured canon fields.
export function looksLikeContradiction(update: BibleUpdate, bible: SocietyBible): boolean {
  // Heuristic: if model reports contradictions, treat as true.
  return update.contradictionsFound.length > 0;
}
