// Shared, transport-agnostic "Society" game logic — used by both the voice
// console (VoiceConsoleV2, realtime audio) and the text console (TextConsoleV2,
// cheap chat-completion turns). Keeping this logic in one place means fixes
// made while iterating in text mode apply to voice automatically.

import type { SocietyBible } from "./societyBible";
import { extractCoreTopicPhrase, normalizeCoreValueUtterance } from "./coreValueNormalize";
import { isSpuriousUserTranscript } from "./transcriptGuards";
import { playfulnessToneGuidance, type Playfulness } from "./prompts";

export const ENGLISH_ONLY_INSTRUCTION =
  "ABSOLUTE RULE: Respond ONLY in English (American or British wording). Never speak Russian, Ukrainian, or any Cyrillic-script language; never German, Dutch, French, Spanish, Italian, Portuguese, or any other language — no code-switching, no mirroring the user's language, no foreign filler words. Do not use Cyrillic in speech. Stay in English even if the user has a non-English accent. No exceptions.";

// Smaller/quantized open-weight models (esp. via OpenRouter) sometimes "leak"
// meta-instructional text into their actual reply instead of just answering
// in-character — markdown headers, "WRONG:"/"RIGHT:" example pairs, delivery
// notes like "stay under 25 words", or a garbled truncated fragment. Appended
// to every non-JSON turn instruction as a last line of defense alongside the
// sanitizer below.
export const OUTPUT_FORMAT_GUARD =
  'OUTPUT FORMAT — CRITICAL: Output ONLY the exact words to say to the player, nothing else. Never include headers, markdown ("###" etc.), "WRONG:"/"RIGHT:" labels, delivery notes about word count or style, or any restatement of these instructions. If your draft would contain anything other than the in-character line itself, delete it and output just the line.';

const LEAK_LINE_PATTERNS: RegExp[] = [
  /^#{1,6}\s/, // markdown headers, e.g. "### EXAMPLE RESPONSE FOR GUIDANCE:"
  /^[-*]\s+\S/, // stray bullet lines — replies are spoken prose, so a "- Stay in your role…" line is leaked instruction text, not dialogue (an em-dash "— …" clause won't match; that's a hyphen-space bullet)
  /^(wrong|right)\s*:/i,
  /^example\s+response\b/i,
  /^anti-sycophancy\b/i,
  /^(hard constraints?|tone dial|voice)\s*:/i,
  /\bstay under \d+ words\b/i,
  /\bcut syllables\b/i,
  /\bdrop\s+filler\s*s?\s*words?\b/i,
  /\bsound like an authority\b/i,
];

/**
 * Strips leaked meta-instructional text (see OUTPUT_FORMAT_GUARD) out of a
 * model reply before it's shown to the player or spoken aloud. Line-based,
 * not a full parse — good enough to remove the obvious artifacts without
 * mangling a legitimate multi-line reply.
 */
export function sanitizeModelReply(text: string): string {
  const kept = text
    .split("\n")
    .filter((raw) => {
      const line = raw.trim();
      if (!line) return true;
      if (LEAK_LINE_PATTERNS.some((p) => p.test(line))) return false;
      // A line starting on a dangling contraction ("'t recruit...") is a
      // truncated/garbled generation artifact, not a real reply.
      if (/^'t\b/i.test(line)) return false;
      return true;
    })
    // Strip stray enumeration markers ("1. ", "2) ") the model sometimes echoes
    // from the three-beat instructions — the CONTENT is real (unlike a leaked
    // bullet line), it's just the number that would be read aloud. Remove the
    // marker, keep the sentence, and let the beats read as flowing speech.
    .map((raw) => raw.replace(/^\s*\d{1,2}[.)]\s+/, ""));
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/** True once sanitized text still looks like a usable in-character reply. */
export function looksLikeUsableReply(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return false;
  if (/^'t\b/i.test(t)) return false;
  if (/^#{1,6}\s/.test(t)) return false;
  if (/^(wrong|right)\s*:/i.test(t)) return false;
  return true;
}

const FILLER_ONLY_LABEL =
  /^(okay|ok|alright|right|yeah|yep|yup|yes|sure|hmm+|uh+|um+|well|so|like|nope|no|definitely|honestly|basically|actually|maybe|perhaps|let'?s see|let me think|i think|i guess|i suppose|i believe|i'd say|i would say)[,.!\s]*$/i;

// Bare imperative verbs left after Whisper dropped the actual topic noun
// (e.g. user said "make snakes the most important thing" but Whisper rendered
// "make the most important thing"). These must be rejected so we re-ask.
const BARE_VERB_LABEL =
  /^(make|have|put|pick|choose|set|name|call|consider|elect|crown|treat|select|count|declare|let'?s|let|so)[,.!\s]*$/i;

// A bare function word (conjunction, article, preposition, pronoun, auxiliary
// verb) can never be a society's "most important thing" — if the label
// collapses to one of these, Whisper mangled or clipped the real answer.
// Without this, a mis-heard opening like "And" sailed through and became the
// core value, which then poisoned EVERY later turn (the prompt forces the
// model to mention the core value, so it kept jamming the word "and" in as if
// it were the society's foundation). The length<3 check already catches the
// 2-letter ones (a, an, of, to, it, is, we, i, or, so...); this covers the
// 3+ letter ones.
const FUNCTION_WORD_LABEL =
  /^(and|but|nor|yet|for|the|any|all|off|out|per|via|about|with|from|into|onto|upon|over|under|they|them|their|theirs|our|ours|you|your|yours|his|her|hers|him|its|that|this|these|those|are|was|were|been|being|has|have|had|does|did|will|would|shall|should|can|could|may|might|must|not|nope|none|null|then|than|there|here|thing|things|stuff|whatever|something|anything|nothing|everything)[,.!\s]*$/i;

export function isWeakCoreValueLabel(label: string): boolean {
  const t = label.replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return true;
  if (t.length < 3) return true;
  if (FILLER_ONLY_LABEL.test(t)) return true;
  if (BARE_VERB_LABEL.test(t)) return true;
  if (FUNCTION_WORD_LABEL.test(t)) return true;
  if (/^the most important thing in (this|the|our) society/.test(t)) return true;
  if (/^what(?:'s| is) the most important thing/.test(t)) return true;
  if (isSpuriousUserTranscript(t)) return true;
  return false;
}

// A greeting or a question/remark aimed AT the co-creator ("hey, are you
// okay?", "can you hear me?", "how are you") is conversational chatter, never
// the society's core value — yet it survives isWeakCoreValueLabel (which only
// catches single filler words). Accepting one made "HEY, ARE YOU OKAY?" the
// society's most important thing. Detected on the RAW utterance so the phrasing
// (second-person address, question form) is still visible.
const GREETING_ONLY =
  /^(hey|hi+|hello+|yo|hiya|howdy|sup|heya|good (morning|afternoon|evening|day))\b[\s,!.?-]*(there|everyone|everybody|folks|guys|friend|friends|again)?[\s,!.?-]*$/i;
const AGENT_DIRECTED =
  /\b(are|is)\s+you\b|\bare\s+you\s+(ok|okay|there|alright|listening|ready|real|human|a\s+robot|an?\s+ai|hearing|still\s+there)\b|\byou\s+(ok|okay|there|alright|listening)\b|\bhow\s+are\s+you\b|\bhow'?s\s+it\s+going\b|\bcan\s+you\s+(hear|understand|see|help)\b|\bdo\s+you\s+(understand|hear|copy|get\s+(it|this)|know|think|read\s+me)\b|\bwhat\s+do\s+you\s+(think|mean|reckon)\b|\bis\s+(this|it)\s+(thing\s+)?(on|working|recording|live|listening|plugged)\b|\bare\s+we\s+(live|recording|on|good)\b/i;

/** True when an utterance is a greeting or a remark/question aimed at the
 *  co-creator rather than a candidate society value — must NOT be accepted or
 *  stored as the core value; re-ask instead. */
export function isNonCoreValueUtterance(raw: string): boolean {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (GREETING_ONLY.test(t)) return true;
  if (AGENT_DIRECTED.test(t)) return true;
  // A short second-person question ("...you...?") is essentially never a value.
  if (/\byou\b/i.test(t) && /\?\s*$/.test(t) && t.split(/\s+/).length <= 8) return true;
  return false;
}

/**
 * Detect an explicit "you misheard the core value — change it to X" correction
 * and return the corrected topic phrase (or "" if this isn't a correction).
 *
 * The hard part is NOT false-triggering on ordinary answers that happen to
 * start with "no" or contain "it's". So we ONLY accept phrasings that clearly
 * signal a meta-correction of the value itself: an explicit "change it to X" /
 * "make it X", a "you got it wrong / misheard ... X", an opener + "I said/meant
 * X", or an "X, not Y" contrast. Bare "no, it's X" is deliberately NOT matched
 * (too ambiguous with a normal answer like "no, it's shameful to be poor").
 */
export function parseUserCorrectionLabel(transcript: string): string {
  const t = transcript.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.split(/\s+/).length > 18) return "";
  const clean = (x: string) => extractCoreTopicPhrase(normalizeCoreValueUtterance(x.trim()));

  let m: RegExpMatchArray | null;

  // "change it / that / the (core) value [back] to X [instead]"
  m = t.match(/\bchange\s+(?:it|that|the\s+(?:core\s+)?value)\s+(?:back\s+)?to\s+(.+?)(?:\s+instead)?[.!]?$/i);
  if (m?.[1]) return clean(m[1]);

  // "make it / the (core) value X [instead]"
  m = t.match(/\bmake\s+(?:it|the\s+(?:core\s+)?value)\s+(.+?)(?:\s+instead)?[.!]?$/i);
  if (m?.[1]) return clean(m[1]);

  // "you got it wrong / you misheard / you heard (it) wrong[, it's/I said] X"
  m = t.match(
    /\byou\s+(?:got\s+it\s+wrong|misheard(?:\s+me)?|heard\s+(?:it\s+|me\s+)?wrong)[,.]?\s*(?:i\s+said\s+|i\s+meant\s+|it'?s\s+|it\s+is\s+)?(.+?)[.!]?$/i
  );
  if (m?.[1] && m[1].trim().length > 1) return clean(m[1]);

  // opener + "I said/meant X" (optionally "X, not Y")
  m = t.match(/^(?:no|nope|actually|wait|sorry|hang on)[,.]?\s+(?:i\s+said(?:\s+it\s+was)?|i\s+meant|i\s+mean)\s+(.+?)(?:,?\s+not\b.*)?[.!]?$/i);
  if (m?.[1]) return clean(m[1]);

  // "I said/meant X, not Y" (the contrast makes it unambiguous, no opener needed)
  m = t.match(/^(?:i\s+said|i\s+meant|i\s+mean)\s+(.+?),?\s+not\b/i);
  if (m?.[1]) return clean(m[1]);

  // opener + "it's X, not Y" (contrast makes it a clear correction)
  m = t.match(/^(?:no|nope|actually|wait)[,.]?\s+(?:it'?s|it\s+is)\s+(.+?),?\s+not\b/i);
  if (m?.[1]) return clean(m[1]);

  return "";
}

export function buildClarifyRepeatInstructions(captured: string): string {
  const capturedPart = captured
    ? `You may have misheard the player as: "${captured}".`
    : "You did not capture a clear core value phrase.";
  return `${ENGLISH_ONLY_INSTRUCTION}

${capturedPart}
Ask the player to repeat the core value in 1-3 words only.
Then ask EXACTLY this sentence and nothing else:
"What's the most important thing in this society? Everything else will follow from it."
Stop and wait for the answer.`;
}

export function hasConcreteFirstImageAnchor(bible: SocietyBible): boolean {
  const generic =
    /most important thing in this society|core value|human asserts|co-creator|started a session|session start|collaboration|inquiry on/i;
  // A canon line counts as "concrete" only if it's a real sentence (>=8 words)
  // and not just an abstract restatement of the core value
  // ("Society values honor", "Honor is foundational", etc.).
  const abstractRestatement =
    /^(this |the )?society\s+(values|prioritizes|prioritises|places|cherishes|reveres|holds|considers|treats|honors|honours|sees|views|emphasizes|emphasises)\b|^(honor|honour|art|technology|love|truth|surveillance|theatre|theater|beauty|music|knowledge)\s+is\s+(the\s+)?(most|foundational|central|key|primary|core|defining|guiding)\b/i;
  return bible.changelog.some((c) => {
    const line = String(c.entry ?? "").trim();
    if (!line) return false;
    if (generic.test(line)) return false;
    if (abstractRestatement.test(line)) return false;
    if (line.split(/\s+/).length < 8) return false;
    return true;
  });
}

/**
 * A compact, persistent summary of the world's established canon — core value,
 * the distilled facts invented so far (deduped), and open threads. Injected
 * into EVERY turn prompt so the model stays grounded in facts that have
 * scrolled out of the short rolling chat window. This is the fix for the model
 * "losing the plot" on longer sessions: history alone only carries the last
 * few exchanges, so anything older was invisible and got forgotten/contradicted.
 */
export function compactCanonSummary(bible: SocietyBible): string {
  const core = (bible?.canon?.coreValues ?? []).filter(Boolean).join(", ").trim();
  const seen = new Set<string>();
  const facts: string[] = [];
  const sorted = [...(bible?.changelog ?? [])].sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0));
  const generic =
    /started a session|session started|most important thing in this society|core value|human asserts|co-creator/i;
  for (const c of sorted) {
    const e = String(c?.entry ?? "").trim();
    if (!e || generic.test(e)) continue;
    const key = e.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(e);
  }
  // Keep the most recent ~18 distilled facts — dense enough to hold the thread
  // across many turns without ballooning the prompt on very long sessions.
  const recent = facts.slice(-18);
  const threads = (bible?.openThreads ?? [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(-6);
  if (!core && recent.length === 0) return "";
  const parts: string[] = [];
  if (core) parts.push(`Core value: ${core}`);
  if (recent.length) parts.push(`Established facts (canon — never contradict these):\n- ${recent.join("\n- ")}`);
  if (threads.length) parts.push(`Open threads you may build on:\n- ${threads.join("\n- ")}`);
  return parts.join("\n\n");
}

export function buildGuidedTurnInstructions(
  coreValue: string,
  playfulness: Playfulness = 1,
  canonSummary = ""
): string {
  const core = coreValue.trim() || "the established core value";
  const canonBlock = canonSummary.trim()
    ? `WORLD SO FAR — this is the established canon of the society. Stay strictly consistent with it and NEVER contradict or forget it. If the player says something that clashes with it, reconcile in-fiction (a rival faction, a region, an earlier era, or propaganda vs. reality) rather than ignoring the conflict:\n${canonSummary.trim()}\n\n`
    : "";
  return `${ENGLISH_ONLY_INSTRUCTION}

You are the player's co-creator in the "Society" worldbuilding game, improvising this world together turn by turn.

${canonBlock}Core value: "${core}". Tone dial (${playfulness}/3): ${playfulnessToneGuidance(playfulness)} Lean into strange, dark, or edgy directions the player brings — make them more specific and vivid, don't soften them. Hard limits only: no real identifiable people, nothing sexual involving minors, no real-world harm instructions. Fade to black on anything graphic.

Voice: a sharp, curious anthropologist fascinated by this culture, not a friendly assistant. Speak directly to the player, in-fiction, no meta-commentary. Never refer to "the player" in third person; never restate "${core}" as if reminding them it's the premise.

This is a fast spoken back-and-forth, NOT a monologue — keep it SHORT: one or two sentences, about 25-35 words total, and stop. Deliver it as natural speech (never a numbered or bulleted list, no labels). In that small space: in a phrase, show you caught what the player just said and what it implies — don't just parrot it, but don't lecture; then ask ONE open question about a part of the society not covered yet (virtue/shame, an ordinary day, failure, conflict/defense, death, status, justice, upbringing, economy). You MAY fold in one small vivid consequence only if it fits in a few words — otherwise skip it.

Use short, punchy sentences. Do NOT stack clauses into long literary run-ons; do NOT pile on adjectives or scenic description. Think quick, sharp conversation, not prose. Stay strictly consistent with the established canon above; never contradict it. The player is building this world from outside it — never ask what they've "seen" or "witnessed"; ask about the system. No compliments, hype, or thanks.`;
}

export function buildCoreValueAcceptedInstructions(coreLabel: string, playfulness: Playfulness = 1): string {
  return `${ENGLISH_ONLY_INSTRUCTION}

Tone dial (${playfulness}/3): ${playfulnessToneGuidance(playfulness)} Lean into strange or dark directions rather than softening them. Voice: a sharp, curious anthropologist fascinated by this culture, not a friendly assistant.

CORE VALUE JUST ESTABLISHED: "${coreLabel}" — the single most important thing in this society. You know almost nothing else about it yet, so resist inventing details; your job this turn is to ask, not answer. Use the player's exact term "${coreLabel}" — never swap in a synonym (e.g. if the term is vanity, don't say beauty or looks).

Respond in two short parts: (1) one short sentence giving "${coreLabel}" some bite as the foundation of this society (more than a flat "X is important"); (2) one open question (no multiple-choice, no invented facts) about how "${coreLabel}" shapes a single concrete facet of life — virtue/shame, an ordinary day, failure, defense, status, death, justice, or upbringing. Don't answer your own question or invent rituals/objects/institutions — that's the player's move.

The player is building this society from outside it, not living inside it — never ask what they've "seen" or "witnessed", ask about the system instead. Never refer to "the player" in third person.

Keep it SHORT and punchy — about 25-30 words, two short sentences max, spoken not literary. No compliments, hype, or thanks.`;
}

/** Shorter fallback used when the core value is established late/off the main onboarding path. */
export function buildCoreValueSafetyNetInstructions(coreLabel: string, playfulness: Playfulness = 1): string {
  return `${ENGLISH_ONLY_INSTRUCTION} Tone dial (${playfulness}/3): ${playfulnessToneGuidance(playfulness)} Lean into strange or dark material rather than softening it. Voice: intellectual, witty, genuinely curious, not a friendly assistant. The player has just named the most important thing in their society: "${coreLabel}". Treat this as the society's core value — it is now hard canon. Mirror it back in one sentence (no compliments). You know almost nothing else about this society yet, so resist inventing details — instead ask ONE genuinely open question (no multiple-choice) about how "${coreLabel}" shapes a single facet: virtue/shame, an ordinary day, failure, defense/conflict, death, status, justice, or upbringing. The player is co-authoring this from outside it, not witnessing it — never ask "what have you seen" or similar perception-based questions; ask about the system instead. Never refer to "the player" in third person or restate the core value as if reminding the audience of it — speak directly, no meta-commentary. Let the player supply the concrete invention. Keep it short and speakable.`;
}

export function buildCorrectionAckInstructions(correctionLabel: string): string {
  return `${ENGLISH_ONLY_INSTRUCTION}

${OUTPUT_FORMAT_GUARD}

The player just corrected the society's core value to "${correctionLabel}". Treat that as the settled core value from now on.

Say exactly two things, in-character, speaking directly to the player:
1. One short sentence that takes the correction in stride (no apology, no defensiveness) and uses the player's exact term "${correctionLabel}".
2. One genuinely open question (no multiple-choice, no invented facts) about a facet of the society that "${correctionLabel}" would shape.

Do NOT use meta words like "canon", "core value", "corrected", or "established" — just speak as the anthropologist. Two sentences, speakable aloud.`;
}

export function buildRulesThenCoreInstructions(): string {
  return `${ENGLISH_ONLY_INSTRUCTION} The player wants to know how the game works. Explain in 2–3 short sentences: players trade yes-and statements building a fictional society one fact at a time; your turn is Mirror (echo back) → light optional Extend (add a concrete detail only if it genuinely follows) → Prompt (mostly open questions, not multiple-choice — you're an interviewer drawing the society out of the player, not the primary inventor). Then immediately ask EXACTLY this: "So — what's the most important thing in this society? Everything else will follow from it." STOP there and wait.`;
}

export function buildGreetingInstructions(): string {
  return `${ENGLISH_ONLY_INSTRUCTION}

You are the voice of the spoken improv worldbuilding game "Society" (one word: Society).

Your first sentence MUST do all of this in English only:
- Name the activity: say it is the "Society" worldbuilding game (or "Society" spoken worldbuilding game).
- Say you are the player's Society co-creator for this session.

Example shape (wording can vary slightly but keep every requirement): "Hi — I'm your Society co-creator; we're playing the Society worldbuilding game together."

Immediately after that sentence, say THESE EXACT WORDS and nothing else:
"What's the most important thing in this society? Everything else will follow from it."

Stop speaking after that quoted sentence and wait for the player's answer.

Rules:
- Do NOT speak any language except English. Never Russian, Ukrainian, or German — English only for every word.
- Do NOT ask about genres, types, or aesthetics (no futuristic, medieval, etc.).
- Do NOT offer categories or examples of society types.
- Do NOT paraphrase or reword the quoted question above — say it verbatim after your intro sentence.
- If the player says they want to know the rules first, explain briefly (yes-and per turn, Mirror → light optional Extend → mostly-open Prompt), then ask the exact same quoted question again.`;
}

export function buildResumeInstructions(coreValue: string, recentCanon: string): string {
  return `${ENGLISH_ONLY_INSTRUCTION}

You are resuming an existing Society session. Treat everything below as hard canon — do NOT invent or contradict it.

CORE VALUE: ${coreValue || "(not yet set)"}

ESTABLISHED CANON:
${recentCanon}

Your job:
1. Welcome the player back in one warm sentence.
2. Briefly remind them of the core value in one sentence, using only the canon above.
3. Ask one genuinely open question (prefer over multiple-choice) about an underexplored facet to continue building. Do not invent new facts.
Keep it short and speakable.`;
}

export const WANTS_RULES_PATTERN =
  /\b(rules?|how (does|do) it work|explain|tell me|walk me through|what('s| is) (the game|it about)|how to play)\b/i;

export const WRAP_UP_PATTERN =
  /\b(wrap(ping)? up|let'?s (finish|end|stop|wrap)|that'?s (enough|all|it)|end (the game|the session|it here)|finish(ed)?|i'?m done|we'?re done|stop (the game|playing)|that'?s a wrap)\b/i;

// Filters echoes of the AI's own scripted onboarding lines / meta chatter out
// of what gets treated as real canon-worthy player content.
export const TURN_GENERIC_PATTERN =
  /started a session|session started|participants have started|society places|society values|central value|central core|shapes all aspects|all other aspects|emerge|game is called society|society is called|dive (straight )?in|let'?s (dive|start|go|begin)|what are the rules|how do(es)? it work|tell me the rules/i;

function formatSessionTitle(coreChoice: string) {
  const collapsed = extractCoreTopicPhrase(
    normalizeCoreValueUtterance(coreChoice.replace(/\s+/g, " ").trim())
  );
  const cleaned = collapsed.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const truncated = cleaned.length > 48 ? `${cleaned.slice(0, 45)}…` : cleaned;
  const lowered = truncated.toLowerCase();
  const genericStarters = ["the society", "every", "dogs are", "agriculture is", "armor making is", "fashion shapes"];
  let core = truncated;
  for (const starter of genericStarters) {
    if (lowered.startsWith(starter)) {
      core = truncated
        .slice(starter.length)
        .replace(/^(\s+is|\s+are|\s+being|\s+places|\s+values|\s+worships)\b/i, "")
        .replace(/^[^a-z0-9]+/i, "")
        .trim();
      break;
    }
  }
  const words = core.split(" ").filter(Boolean).slice(0, 3);
  return words.join(" ");
}

export function pickSessionTitle(bible: SocietyBible, parsedCore?: string, parsedTitle?: string) {
  const core0 = String(parsedCore ?? bible?.canon?.coreValues?.[0] ?? getCoreChoice(bible) ?? "").trim();
  const formatted = formatSessionTitle(core0 || "");
  if (formatted) return formatted;
  if (parsedTitle) return formatSessionTitle(String(parsedTitle).trim());

  const genericPattern = /started a session|session started|participants have started/i;
  const firstCanon = bible.changelog
    .slice()
    .sort((a, b) => a.turn - b.turn)
    .map((c) => String(c.entry ?? "").trim())
    .find((entry) => entry && !genericPattern.test(entry));

  return formatSessionTitle(firstCanon || "") || `Society ${new Date().toLocaleString()}`;
}

export function getCoreChoice(bible: SocietyBible) {
  const explicit = String(bible?.canon?.coreValues?.[0] ?? "").trim();
  const lastUser = String(bible?.lastUserUtterance ?? "").trim();
  const genericPattern = /started a session|session started|participants have started|society places|central value|shapes all aspects of life/i;
  if (explicit) return explicit;
  if (lastUser && !genericPattern.test(lastUser)) return lastUser;
  const firstCanon = bible.changelog
    .slice()
    .sort((a, b) => a.turn - b.turn)
    .map((c) => String(c.entry ?? "").trim())
    .find((entry) => entry && !genericPattern.test(entry));
  return firstCanon || "";
}
