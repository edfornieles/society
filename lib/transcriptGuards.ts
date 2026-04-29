/**
 * Filters junk ASR lines: meeting-app watermarks, URLs read aloud, attribution text,
 * or background audio transcribed into the user channel.
 */
export function isSpuriousUserTranscript(text: string): boolean {
  const t = text.trim();
  if (t.length < 4) return false;

  const lower = t.toLowerCase();

  if (/\bhttps?:\/\//i.test(t)) return true;
  if (/\bwww\.[a-z0-9.-]+\b/i.test(t)) return true;
  if (/\bgo\s+to\s+[a-z0-9][a-z0-9.-]*\.(ai|com|net|io|org)\b/i.test(lower)) return true;
  if (/\bfor\s+all\s+of\s+your\s+\w+\s+needs\b/i.test(lower)) return true;
  if (/\b(beading|craft|supply)\s+need(s)?\b/i.test(lower)) return true;

  if (/\botter\b/i.test(lower)) return true;
  if (/\btranscribed\s+by\b/i.test(lower)) return true;
  if (/\btranscription\s+(by|from|powered)\b/i.test(lower)) return true;
  if (/\bcaption(s|ing)?\s+(by|from)\b/i.test(lower)) return true;
  if (/\bsubtitles?\s+(by|from)\b/i.test(lower)) return true;

  // Domain-shaped tokens often appear when another tab or OS audio leaks in.
  if (/\b[a-z0-9][a-z0-9.-]*\.(ai|com|net|io|org)\b/i.test(lower) && /transcrib|caption|subtitle|meeting|recorded/i.test(lower)) {
    return true;
  }

  // Whisper / UI instruction bleed (must match phrases we never want as "user" canon)
  if (/\btranscribe\s+only\b/i.test(lower)) return true;
  if (/\bwhat\s+the\s+speaker\s+said\b/i.test(lower) && /transcrib|ignore\s+background|meeting\s+apps/i.test(lower)) return true;
  if (/\bignore\s+background\s+audio\b/i.test(lower)) return true;
  if (/\bmeeting\s+apps\b/i.test(lower) && /url|caption|transcrib/i.test(lower)) return true;
  // Full-line echo of our old long prompt
  if (/lines\s+like\s+transcribed\s+by\s+or\s+captions/i.test(lower)) return true;

  return false;
}
