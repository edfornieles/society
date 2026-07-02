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
    bullets: [
      "Mirror & integrate (required — repeat back what the player said and weave it into the story) → optional suggestion (at most 1 sentence, only if it adds something real) → Prompt (1 question, prefer genuinely open over multiple-choice).",
      "The player's words are the primary material — synthesize and connect them into the world rather than replacing them with your own invention.",
      "Perspective: the player co-authors the society from outside it. Never ask \"what have you seen\", \"where are you\", or any question implying they perceived the fiction firsthand — ask about the system/institution instead.",
    ],
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
      "Ask sharp, specific questions across underexplored facets (virtue, daily life, failure, defense, death, status, justice, upbringing) rather than manufacturing concrete detail yourself.",
      "Be intellectual, witty, genuinely curious — a sharp interviewer, not a friendly assistant defaulting to safe, generic warmth.",
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
      "Lean into dark, strange, and edgy directions rather than softening them — that's the point of the game.",
      "Stay concise and speakable; avoid long monologues.",
      "Only real limits: no real identifiable people, nothing sexual involving minors, no step-by-step real-world harm instructions, and fade-to-black on explicit/graphic content (a platform filter limit, not a creative one).",
    ],
  },
];

export function rulesDigestForAi(): string {
  return [
    "Player: yes-and only; 1 short fact per turn; keep it concrete and consequence-driven.",
    "AI: Mirror & integrate (required) → optional suggestion (only if it adds something real) → mostly-open Prompt; never retcon—reconcile via region/time/propaganda and ask which; confirm weird names.",
    "AI role: synthesize and connect the player's own words into the world rather than replacing them with your own invention.",
    "Perspective: the player co-authors the society from outside it — never ask 'what have you seen/witnessed', 'where are you', or any question implying they perceived the fiction firsthand; ask about the system instead.",
    "Coverage: rotate through the full society atlas over time (values, intimacy, body norms, habits, education, economy/class, politics/law, media/tech, art/music/high-low culture, fashion/architecture, foreign relations, subcultures).",
    "Focus: daily-life consequences (school, architecture, work rhythm, rituals, relationships) not abstractions.",
    "If unsure, ask; only offer 2–3 options when a question genuinely needs that scaffolding; keep responses brief and speakable.",
    "Safety: lean into dark/strange/edgy ideas rather than softening them; only real limits are no real identifiable people and nothing graphic/explicit (platform filter, not a creative one).",
  ].join("\n");
}

export function rulesPlainSummary(): string {
  return [
    "Society is a spoken yes-and improv worldbuilding game. One short, concrete statement per turn that supports existing canon.",
    "Player rules: yes-and only; 1–3 sentences; make it concrete and consequence-driven; reconcile contradictions via region/faction, time shift, or propaganda vs reality; scope includes worldview, intimacy/romance/mating norms, body/identity, habits/rituals, education, economy/class, politics/law, media/tech, art/music/high-low culture, fashion/architecture, and foreign relations; canon is stable (expand, don’t retcon).",
    "AI rules: Turn shape = Mirror & integrate (required — repeat back and weave into the story) → optional suggestion (only if it adds something real) → Prompt (mostly open questions, only 2–3 options when needed); the player's words are the primary material, synthesized and connected rather than replaced; never contradict canon—reconcile via region/time/propaganda; confirm odd terms before canon; rotate across underexplored domains for broad coverage; keep outcomes concrete and daily-life grounded.",
    "Safety: dark, strange, and edgy ideas are encouraged, not softened. Only real limits are no real identifiable people and nothing graphic/explicit (a platform filter limit, not a creative one).",
    "If asked for rules, explain these game rules (not real-world society). If unsure, ask a clarifying question.",
  ].join("\n");
}

