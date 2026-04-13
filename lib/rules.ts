export const playerRulesSections = [
  {
    title: "Goal",
    bullets: [
      "Co-invent a fictional society by trading yes-and statements.",
      "Each turn adds one short fact (values, architecture, education, daily life, foreign policy, culture).",
    ],
  },
  {
    title: "Core rule: Yes-and",
    bullets: [
      "Support established canon; if you need to bend, reconcile via region/faction, time shift, or propaganda vs reality.",
      "Favor evolution over contradiction.",
    ],
  },
  {
    title: "Turn shape",
    bullets: [
      "One move = one fact, clarification, consequence, or tiny vignette.",
      "Keep it 1–3 sentences and concrete (spaces, rituals, objects, jobs, senses).",
    ],
  },
  {
    title: "Consequences",
    bullets: ["Each fact should imply a change in daily life: if X is true, then Y shifts."],
  },
  {
    title: "Scope menu",
    bullets: [
      "Worldview/values/myth; kinship/intimacy (friendship, courtship, romance, mating norms, sexual norms as social rules); body/identity (gender, disability, rites of passage, beauty ideals); daily habits/etiquette/ritual; childhood/education; work/economy/class/status; politics/power/propaganda; law/justice/surveillance; environment/infrastructure; technology/media/memory; art/music/high and low culture; fashion/food/leisure/sport; architecture/public-private space; foreign policy/trade/war/migration; subcultures and underground scenes.",
    ],
  },
  {
    title: "Continuity",
    bullets: [
      "Canon stays stable; expand instead of retconning.",
      "If unsure, ask to confirm before staking new canon.",
    ],
  },
  {
    title: "Optional spice",
    bullets: [
      "Callbacks every few turns; utopian benefits need costs; speak from a role sometimes (“As a teacher…”).",
    ],
  },
  {
    title: "End & safety",
    bullets: [
      "Stop when it feels complete or finish with a vignette tying themes.",
      "If topics drift toward harm or real persons, steer back to abstract institutions and consequences.",
    ],
  },
];

export const aiRulesSections = [
  {
    title: "Turn format (hard rule)",
    bullets: ["Mirror (1 sentence) → Extend (1–2 sentences) → Prompt (1 question, 2–3 options)."],
  },
  {
    title: "Canon discipline",
    bullets: [
      "Never contradict canon; reconcile conflict via region/faction, time shift, or propaganda vs reality and ask the user to choose.",
      "Confirm odd proper nouns (ASR guardrail) before canonizing.",
    ],
  },
  {
    title: "Creativity & tone",
    bullets: [
      "Prefer concrete, sensory consequences in daily life over abstractions.",
      "Be warm, curious, lightly funny; make the user’s ideas shine.",
    ],
  },
  {
    title: "State tracking",
    bullets: [
      "Track core_values, status_markers, institutions, daily_life, constraints, open_threads, tone.",
      "If unsure, log it as an open thread instead of hard canon.",
      "Track coverage across domains and prioritize underexplored parts of society over repeating familiar topics.",
    ],
  },
  {
    title: "Contradiction handling",
    bullets: [
      "Offer reconciliation options instead of saying no.",
      "If misheard, ask for confirmation before adding to canon.",
    ],
  },
  {
    title: "Safety",
    bullets: [
      "Keep it non-graphic and non-targeted; redirect to worldbuilding if needed.",
      "Stay concise and speakable; avoid long monologues.",
      "Intimate topics are allowed as social/institutional worldbuilding, but never explicit sexual content.",
    ],
  },
];

export function rulesDigestForAi(): string {
  return [
    "Player: yes-and only; 1 short fact per turn; keep it concrete and consequence-driven.",
    "AI: Mirror → Extend → Prompt; never retcon—reconcile via region/time/propaganda and ask which; confirm weird names.",
    "Coverage: rotate through the full society atlas over time (values, intimacy, body norms, habits, education, economy/class, politics/law, media/tech, art/music/high-low culture, fashion/architecture, foreign relations, subcultures).",
    "Focus: daily-life consequences (school, architecture, work rhythm, rituals, relationships) not abstractions.",
    "If unsure, ask; if stalled, offer 2–3 options; keep responses brief and speakable.",
    "Safety: stay non-graphic/non-targeted; intimate topics okay in social terms, never explicit sexual content.",
  ].join("\n");
}

export function rulesPlainSummary(): string {
  return [
    "Society is a spoken yes-and improv worldbuilding game. One short, concrete statement per turn that supports existing canon.",
    "Player rules: yes-and only; 1–3 sentences; make it concrete and consequence-driven; reconcile contradictions via region/faction, time shift, or propaganda vs reality; scope includes worldview, intimacy/romance/mating norms, body/identity, habits/rituals, education, economy/class, politics/law, media/tech, art/music/high-low culture, fashion/architecture, and foreign relations; canon is stable (expand, don’t retcon).",
    "AI rules: Turn shape = Mirror (1 sentence) → Extend (1–2 sentences) → Prompt (1 question, 2–3 options); never contradict canon—reconcile via region/time/propaganda; confirm odd terms before canon; rotate across underexplored domains for broad coverage; keep outcomes concrete and daily-life grounded.",
    "Safety: non-graphic and non-targeted; intimate topics are allowed in social/institutional terms but never explicit sexual content.",
    "If asked for rules, explain these game rules (not real-world society). If unsure, ask a clarifying question.",
  ].join("\n");
}

