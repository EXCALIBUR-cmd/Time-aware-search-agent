import * as chrono from 'chrono-node';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

export type TimeRange = { phrase: string; start: Date; end: Date };

const DAY = 86_400_000;

export const refersToPast = (ranges: TimeRange[], now: Date): boolean =>
  ranges.some((r) => r.start <= now && !/^(today|tonight)$/i.test(r.phrase));

export function resolveTime(text: string, now: Date, tz: string): TimeRange[] {
  const local = toZonedTime(now, tz);
  const today = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
  const iso = (day: number) => new Date(day).toISOString().slice(0, 10);
  const range = (phrase: string, from: number, to: number): TimeRange => ({
    phrase,
    start: fromZonedTime(`${iso(from)}T00:00:00.000`, tz),
    end: fromZonedTime(`${iso(to)}T23:59:59.999`, tz),
  });

  const out: TimeRange[] = [];
  let rest = text;
  const lastWeek = /\blast week\b/i.exec(text);
  if (lastWeek) {
    const monday = today - (((new Date(today).getUTCDay() + 6) % 7) + 7) * DAY;
    out.push(range(lastWeek[0], monday, monday + 6 * DAY));
    rest = text.replace(lastWeek[0], ' ');
  }
  for (const r of chrono.parse(rest, local)) {
    if (/^(right )?now$/i.test(r.text)) continue;
    const day = (c: chrono.ParsedComponents, yearShift = 0) =>
      Date.UTC((c.get('year') ?? 0) + yearShift, (c.get('month') ?? 1) - 1, c.get('day') ?? 1);
    let from = day(r.start);
    let to = r.end ? day(r.end) : from;
    if (r.start.isCertain('month') && !r.start.isCertain('year') && from > today) {
      from = day(r.start, -1);
      to = r.end ? day(r.end, -1) : from;
    }
    const bareWeekday =
      r.start.isCertain('weekday') && !r.start.isCertain('day') && !/\b(next|this|last)\b/i.test(r.text);
    if (bareWeekday && from > today) {
      from -= 7 * DAY;
      to -= 7 * DAY;
    }
    if (bareWeekday && from === today) out.push(range(r.text, from - 7 * DAY, to - 7 * DAY));
    out.push(range(r.text, from, to));
  }
  const dated = out.filter((r) => !/^(today|tonight)$/i.test(r.phrase));
  return (dated.length ? dated : out).map((r) => (r.end > now ? { ...r, end: now } : r));
}
