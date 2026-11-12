import { formatInTimeZone } from 'date-fns-tz';
import { expect, test } from 'vitest';
import { refersToPast, resolveTime } from './resolve';

const tz = 'Asia/Kolkata';
const now = new Date('2026-11-07T10:00:00+05:30');
const fmt = (d: Date) => formatInTimeZone(d, tz, 'yyyy-MM-dd HH:mm');
const days = (text: string) => resolveTime(text, now, tz).map((r) => `${fmt(r.start)} → ${fmt(r.end)}`);

test.each([
  ['Last Tuesday I asked you about Postgres hosting.', '2026-11-03'],
  ['What did I ask you on 3 November?', '2026-11-03'],
  ['On Monday we shortlisted 5 CRM tools for a 20-person sales team.', '2026-11-02'],
  ['What did we talk about yesterday?', '2026-11-06'],
  ['What did I ask you on 3 November? Is your answer still correct today?', '2026-11-03'],
])('%s', (text, day) => expect(days(text)).toEqual([`${day} 00:00 → ${day} 23:59`]));

test('last week is Monday to Sunday of the previous week', () =>
  expect(days('What did we discuss last week?')).toEqual(['2026-10-26 00:00 → 2026-11-01 23:59']));

test('a weekday named on that same weekday covers a week ago and today', () => {
  const monday = new Date('2026-11-09T10:00:00+05:30');
  const ranges = resolveTime('On Monday we shortlisted 5 CRM tools', monday, tz).map((r) => fmt(r.start));
  expect(ranges).toEqual(['2026-11-02 00:00', '2026-11-09 00:00']);
  expect(resolveTime('Last Tuesday I asked about Postgres', monday, tz).map((r) => fmt(r.start))).toEqual(['2026-11-03 00:00']);
  expect(resolveTime('What did we discuss last week?', monday, tz).map((r) => fmt(r.end))).toEqual(['2026-11-08 23:59']);
});

test('an explicit date resolves to its most recent past occurrence (no forwardDate)', () => {
  const on = (iso: string) => resolveTime('i told that to you on 1st nov', new Date(iso), tz).map((r) => fmt(r.start));
  expect(on('2026-11-03T10:00:00+05:30')).toEqual(['2026-11-01 00:00']);
  expect(on('2026-11-01T11:23:00+05:30')).toEqual(['2026-11-01 00:00']);
  expect(on('2026-06-03T10:00:00+05:30')).toEqual(['2025-11-01 00:00']);
  expect(on('2027-02-03T10:00:00+05:30')).toEqual(['2026-11-01 00:00']);
});

test('refersToPast: a named day that has begun forces memory, a bare "today" does not', () => {
  const past = (text: string, iso: string) => refersToPast(resolveTime(text, new Date(iso), tz), new Date(iso));
  expect(past('i told that to you on 1st nov', '2026-11-03T10:00:00+05:30')).toBe(true);
  expect(past('i told that to you on 1st nov', '2026-11-01T11:23:00+05:30')).toBe(true);
  expect(past("what's the weather today?", '2026-11-03T10:00:00+05:30')).toBe(false);
  expect(past('what is the latest Next.js version?', '2026-11-03T10:00:00+05:30')).toBe(false);
});

test('no date phrase gives no ranges', () => {
  expect(days("What's the latest Next.js version?")).toEqual([]);
  expect(days('What does Neon cost now?')).toEqual([]);
});
