export type BibleCanon = {
  coreValues: string[];
  statusMarkers: string[];
  institutions: Partial<Record<"education" | "law" | "care" | "media" | "religion", string>>;
  dailyLife: Partial<Record<"housing" | "work" | "leisure" | "food", string>>;
  constraints: Partial<Record<"environment" | "resources" | "techLevel", string>>;
  aesthetics: Partial<Record<"architecture" | "fashion" | "art", string>>;
  foreignPolicy?: string;
};

export type SocietyBible = {
  canon: BibleCanon;
  openThreads: string[];
  turnCount: number;
  lastUserUtterance?: string;
  lastAiUtterance?: string;
  changelog: { turn: number; entry: string; at: string }[];
};

export function createEmptyBible(): SocietyBible {
  return {
    canon: {
      coreValues: [],
      statusMarkers: [],
      institutions: {},
      dailyLife: {},
      constraints: {},
      aesthetics: {},
    },
    openThreads: [],
    turnCount: 0,
    changelog: [],
  };
}

export function addCanonLines(bible: SocietyBible, lines: string[], turn: number): SocietyBible {
  const at = new Date().toISOString();
  const cleaned = lines.map((s) => s.trim()).filter(Boolean);
  const next = structuredClone(bible);
  for (const line of cleaned) next.changelog.push({ turn, entry: line, at });
  return next;
}

export function addOpenThreads(bible: SocietyBible, threads: string[]): SocietyBible {
  const cleaned = threads.map((s) => s.trim()).filter(Boolean);
  const next = structuredClone(bible);
  for (const t of cleaned) {
    if (!next.openThreads.includes(t)) next.openThreads.push(t);
  }
  return next;
}

export function bumpTurn(bible: SocietyBible): SocietyBible {
  const next = structuredClone(bible);
  next.turnCount += 1;
  return next;
}
