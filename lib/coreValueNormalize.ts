/**
 * Collapse repeated echoes of the scripted question ("the most important thing…")
 * and hedges ("I think") into one canonical line or a short topic phrase.
 * Also summarises elaborations ("beauty is important, and specifically physical beauty" → "physical beauty").
 */

const BOILERPLATE = /\bthe\s+most\s+important\s+thing\s+in\s+this\s+society\s+is\b/gi;

const HEDGE = /^(i think|i believe|i guess|i suppose|well|um|uh|so|like)[,.]?\s+/i;

/**
 * Prefer the user's most specific gist: e.g. drop "beauty is the most important thing"
 * when they narrow with "specifically physical beauty".
 */
function summarizeCoreTopicFragment(topic: string): string {
  let t = topic.replace(/\s+/g, " ").trim();
  if (!t) return t;

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

  if (!s) return collapsed;

  let topic = s.replace(/\.$/, "").trim();
  topic = summarizeCoreTopicFragment(topic);
  if (!topic) return collapsed;

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
