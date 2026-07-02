/**
 * Capture-time anchoring of relative dates. "My flight is tomorrow at 6pm" is
 * meaningless a week after it was said, so at WRITE time we resolve common
 * relative expressions against the capture date and append an absolute anchor:
 *
 *   "My flight is tomorrow at 6pm"  →  "My flight is tomorrow at 6pm [tomorrow = 2026-07-03]"
 *
 * The original wording is preserved (appended, never rewritten), the anchor is
 * plain text so keyword/vector recall and the answer model all see it, and the
 * content hash naturally differs across days (the same sentence said on a
 * different day refers to a different date — that IS a different fact).
 *
 * Deliberately conservative and dependency-free: only unambiguous patterns are
 * anchored; anything else is left untouched. Pure + deterministic (caller passes
 * `now`) so it's unit-testable.
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(now: Date, n: number): string {
  return iso(new Date(now.getTime() + n * DAY_MS));
}

/** Days ahead to the coming occurrence of `weekday` (1..7 — never "today"). */
function daysToNext(now: Date, weekday: number): number {
  const diff = (weekday - now.getDay() + 7) % 7;
  return diff === 0 ? 7 : diff;
}

interface Anchor {
  phrase: string;
  date: string; // YYYY-MM-DD
}

/** Find relative-date expressions and resolve each to an absolute date. */
export function findRelativeDates(content: string, now: Date): Anchor[] {
  const anchors: Anchor[] = [];
  const seen = new Set<string>();
  const push = (phrase: string, date: string) => {
    const key = phrase.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      anchors.push({ phrase, date });
    }
  };

  // day after tomorrow (check before plain "tomorrow")
  const dat = content.match(/\bday after tomorrow\b/i);
  if (dat) push(dat[0], addDays(now, 2));

  // tomorrow / tonight / today / yesterday
  const simple: Array<[RegExp, number]> = [
    [/\btomorrow\b/i, 1],
    [/\btonight\b/i, 0],
    [/\bthis (?:morning|afternoon|evening)\b/i, 0],
    [/\byesterday\b/i, -1],
  ];
  for (const [re, offset] of simple) {
    const m = content.match(re);
    // skip "tomorrow" if it was part of "day after tomorrow"
    if (m && !(offset === 1 && dat && dat[0].toLowerCase().includes('tomorrow'))) {
      push(m[0], addDays(now, offset));
    }
  }

  // next/this <weekday>, or on/by/until <weekday>
  const wdRe = /\b(next|this|on|by|until|every)?\s*\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;
  for (const m of content.matchAll(wdRe)) {
    const qualifier = (m[1] ?? '').toLowerCase();
    const weekday = WEEKDAYS.indexOf(m[2]!.toLowerCase());
    if (qualifier === 'every') continue; // recurring — no single date
    if (!qualifier) continue; // bare weekday ("I hate Mondays") — too ambiguous, skip
    let days: number;
    if (qualifier === 'this') days = (weekday - now.getDay() + 7) % 7; // 0..6 — can be today
    else if (qualifier === 'next') days = daysToNext(now, weekday) + (daysToNext(now, weekday) <= 3 ? 7 : 0); // "next Fri" said on Thu = the week after
    else days = daysToNext(now, weekday); // on/by/until — the coming one
    push(m[0].trim(), addDays(now, days));
  }

  // in N day(s)/week(s)
  for (const m of content.matchAll(/\bin (\d{1,2}) (day|days|week|weeks)\b/gi)) {
    const n = Number(m[1]);
    const days = m[2]!.toLowerCase().startsWith('week') ? n * 7 : n;
    push(m[0], addDays(now, days));
  }

  return anchors;
}

/** Append `[phrase = date; …]` when relative dates are present; otherwise return as-is. */
export function anchorRelativeDates(content: string, now = new Date()): string {
  // Don't double-anchor (idempotent for re-writes of already-anchored text).
  if (/\[[^\]]* = \d{4}-\d{2}-\d{2}[^\]]*\]\s*$/.test(content)) return content;
  const anchors = findRelativeDates(content, now);
  if (anchors.length === 0) return content;
  const note = anchors.map((a) => `${a.phrase} = ${a.date}`).join('; ');
  return `${content} [${note}]`;
}
