/**
 * Resolve relative due-date phrases to absolute YYYY-MM-DD.
 * Returns undefined when nothing parses.
 */
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export function resolveDueDate(text: string, baseISO?: string): string | undefined {
  if (!baseISO) return undefined;
  const base = new Date(baseISO);
  if (Number.isNaN(base.getTime())) return undefined;
  const lower = text.toLowerCase();

  for (let i = 0; i < WEEKDAYS.length; i++) {
    const day = WEEKDAYS[i]!;
    if (new RegExp(`\\bby ${day}\\b`).test(lower)) {
      return nextWeekdayISO(base, i);
    }
  }
  if (/\bby next week\b/.test(lower)) return addDaysISO(base, 7);
  if (/\bby end of (?:the )?week\b/.test(lower)) return nextWeekdayISO(base, 5);
  if (/\bby end of (?:the )?day\b/.test(lower)) return toISODate(base);
  return undefined;
}

function nextWeekdayISO(from: Date, target: number): string {
  const cur = from.getUTCDay();
  let delta = (target - cur + 7) % 7;
  if (delta === 0) delta = 7;
  return addDaysISO(from, delta);
}

function addDaysISO(from: Date, n: number): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
