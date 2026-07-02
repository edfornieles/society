/**
 * Collapse repeated echoes of the scripted question ("the most important thing…")
 * and hedges ("I think") into one canonical line or a short topic phrase.
 * Also summarises elaborations ("beauty is important, and specifically physical beauty" → "physical beauty").
 */

// Strip "[is/are] the most important thing in [this/the/our] society [is/are]"
// wherever it appears. Whisper sometimes echoes the AI's question into the
// user transcript with or without "is/are", and users phrase the answer as
// "snakes are the most important thing" / "make snakes the most important
// thing in this society". This regex eats the entire boilerplate clause
// including the surrounding copula so we land cleanly on the topic noun.
const BOILERPLATE =
  /\s*(?:\b(?:is|are|was|were|will\s+be|would\s+be)\s+)?the\s+most\s+important\s+thing\s+in\s+(?:this|the|our)\s+society(?:\s+(?:is|are|was|were|will\s+be|would\s+be))?\b/gi;

const HEDGE = /^(i think|i believe|i guess|i suppose|i'd say|i would say|maybe|perhaps|well|um|uh|er|hmm|so|like|okay|ok|alright|right|yeah|yep|yup|yes|sure|definitely|honestly|basically|actually|let'?s see|let me think)[,.!]?\s+/i;

/**
 * Prefer the user's most specific gist: e.g. drop "beauty is the most important thing"
 * when they narrow with "specifically physical beauty".
 */
function summarizeCoreTopicFragment(topic: string): string {
  let t = topic.replace(/\s+/g, " ").trim();
  if (!t) return t;

  // Imperative form: "make/let's make/have/etc. <X> the most important thing
  // in (this|the|our) society" — extract <X>. Run this BEFORE we strip the
  // boilerplate so we still know where <X> was sitting.
  const imperative = t.match(
    /^(?:so\s+)?(?:i\s+want\s+to\s+|i'?d\s+like\s+to\s+|i\s+would\s+like\s+to\s+|let'?s\s+|let\s+us\s+|please\s+)?(?:make|have|consider|treat|put|pick|choose|select|name|call|set|count|declare|elect|crown)\s+(.+?)\s+the\s+most\s+important\s+thing\s+in\s+(?:this|the|our)\s+society\b/i
  );
  if (imperative?.[1]?.trim()) {
    t = imperative[1].trim();
  }

  // Remove repeated tail forms like:
  // "money, money is the most important thing in the society"
  t = t
    .replace(/\b(?:is|are)\s+the\s+most\s+important\s+thing\s+in\s+(?:this|the|our)\s+society\b.*$/i, "")
    .trim();

  // Strip leading bare imperative verb if it's still there
  // (e.g. "make snakes" after Whisper dropped the rest of the sentence;
  // also handle "make" alone, which becomes empty and gets rejected upstream).
  t = t.replace(/^(?:make|have|put|pick|choose|set|name|call|consider|elect|crown|treat|select|count|declare)\b\s*/i, "").trim();
  t = t.replace(/^(?:let'?s|let\s+us|please)\s+/i, "").trim();
  t = t.replace(/^(?:for\s+me[,.!]?\s+|to\s+me[,.!]?\s+|that\s+(?:would\s+be|is|'s)\s+|it\s+(?:would\s+be|is|'s)\s+)/i, "").trim();

  // Whisper sometimes drops "is" between the topic and the boilerplate, leaving
  // "<X> the most important thing [in ...society]". Pull <X> out.
  const noCopula = t.match(/^(.+?)\s+the\s+most\s+important\s+thing\b/i);
  if (noCopula?.[1]?.trim()) {
    t = noCopula[1].trim();
  }

  // Trailing copula (e.g. "snakes are" after the boilerplate was eaten).
  t = t.replace(/\s+(?:is|are|was|were|will\s+be|would\s+be)\s*\.?$/i, "").trim();

  // Collapse simple duplicated fragments: "money, money" -> "money"
  const dupFragment = t.match(/^(.+?),\s*\1$/i);
  if (dupFragment?.[1]?.trim()) {
    t = dupFragment[1].trim();
  }

  // Collapse duplicated leading token: "money, money ..." -> "money ..."
  t = t.replace(/^([a-z0-9'/-]+)\s*,\s*\1\b\s*/i, "$1 ").trim();

  // 1) Narrowing phrases — take the more specific tail (highest priority).
  const narrowPatterns: RegExp[] = [
    /,\s*and\s+specifically\s+(.+)$/i,
    /\band\s+specifically\s+(.+)$/i,
    /,\s*specifically\s+(.+)$/i,
    /[—–-]\s*specifically\s+(.+)$/i,
    /\bnamely\s+(.+)$/i,
    /\bin other words[,:]\s*(.+)$/i,
    /\bthat\s+is\s*(?:to\s+say\s*)?[,:]?\s*(.+)$/i,
  ];
  for (const re of narrowPatterns) {
    const m = t.match(re);
    if (m?.[1]?.trim()) {
      t = m[1].trim();
      break;
    }
  }

  // 2) Two-part comma sentence: "blah is the most important thing, <rest>" — if <rest> looks like
  //    the real answer (e.g. starts with "and specifically" already stripped), or is a short noun phrase.
  const commaSplit = t.match(
    /^(.+?)\s+is\s+the\s+most\s+important\s+thing\s*,\s*(.+)$/i
  );
  if (commaSplit?.[2]?.trim()) {
    const rest = commaSplit[2].trim();
    // If first clause was generic importance talk and second is concrete, prefer second.
    if (!/^and\s+specifically\b/i.test(rest)) {
      const restWords = rest.split(/\s+/).length;
      const firstWords = commaSplit[1].split(/\s+/).length;
      if (restWords <= 12 && (restWords < firstWords || /physical|specific|exactly|above\s+all/i.test(rest))) {
        t = rest;
      }
    }
  }

  // 3) If the whole fragment is only "X is the most important thing" (no narrower topic), keep X.
  const onlyImportance = t.match(/^(.+?)\s+is\s+the\s+most\s+important\s+thing\.?$/i);
  if (onlyImportance?.[1]?.trim()) {
    const inner = onlyImportance[1].trim();
    if (inner.split(/\s+/).length <= 6) {
      t = inner;
    }
  }

  return t.replace(/\.$/, "").trim();
}

/**
 * If the user repeated the prompt or hedged, returns:
 *   `The most important thing in this society is {topic}.`
 * If they gave a direct short answer (no template echo), returns the topic only.
 */
export function normalizeCoreValueUtterance(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";

  let s = collapsed;
  let hadBoilerplate = false;
  let prev = "";
  while (prev !== s) {
    prev = s;
    const next = s.replace(BOILERPLATE, " ").replace(/\s+/g, " ").trim();
    if (next !== s) hadBoilerplate = true;
    s = next;
  }

  while (HEDGE.test(s)) {
    s = s.replace(HEDGE, "").trim();
  }

  // If stripping the boilerplate / hedges ate the entire utterance, the user
  // never gave a real topic (e.g. "make the most important thing in this
  // society" — Whisper dropped the actual word). Return empty so the caller's
  // weak-label guard re-asks instead of storing the boilerplate.
  if (!s) return "";

  let topic = s.replace(/\.$/, "").trim();
  topic = summarizeCoreTopicFragment(topic);
  if (!topic) return "";

  if (hadBoilerplate) {
    return `The most important thing in this society is ${topic}.`;
  }

  return topic;
}

/** Topic only — for titles, keywords, and bible fields that should not repeat the full template. */
export function extractCoreTopicPhrase(stored: string): string {
  const t = stored.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = t.match(/^The most important thing in this society is (.+?)\.?$/i);
  if (m) return m[1].replace(/\.$/, "").trim();
  return t.replace(/\.$/, "").trim();
}
