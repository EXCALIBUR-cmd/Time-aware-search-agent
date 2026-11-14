import { expect, test } from 'vitest';
import { buildInstructions, verdictSince } from './agent/prompt';
import { citedNumbers, citedSources } from './citations';

const source = (sourceId: string, url: string) => ({ sourceId, url });

test('only the sources the answer cites are shown, each URL once, in their original order', () => {
  const answer = 'Neon is unchanged [2]. Supabase too [5][2]. Railway (third-party source) [7].';
  const sources = [
    source('1', 'https://neon.com/blog'),
    source('2', 'https://neon.com/pricing'),
    source('5', 'https://supabase.com/pricing'),
    source('6', 'https://railway.com/pricing'),
    source('7', 'https://getdeploying.com/railway'),
    source('8', 'https://neon.com/pricing'),
  ];
  expect([...citedNumbers(answer)]).toEqual(['2', '5', '7']);
  expect(citedSources(answer, sources).map((s) => s.sourceId)).toEqual(['2', '5', '7']);
  expect(citedSources('No citations here.', sources)).toEqual([]);
});

test('a re-verification answer is told to lead with a dated verdict and to carry no heading', () => {
  const instructions = buildInstructions({
    mode: 'reverify',
    now: new Date('2026-11-14T10:00:00+05:30'),
    tz: 'Asia/Kolkata',
    searchedAlready: true,
    verdictSince: 'Tue 10 Nov',
  });
  expect(instructions).toContain('"**Nothing has changed since Tue 10 Nov.**"');
  expect(instructions).toContain('"**Two prices changed since Tue 10 Nov.**"');
  expect(instructions).toContain('No heading or title anywhere in the answer.');
  expect(instructions).toContain('End with a "Sources" list of only the results you cited, each listed once');
});

test('the verdict is dated from the oldest claim compared, so it matches the table', () => {
  const askedAbout = [new Date('2026-11-10T00:00:00+05:30')];
  const claims = ['2026-11-13T15:07:27.553Z', '2026-11-03T07:09:00.000Z', '2026-11-03T15:04:00.000Z'];
  expect(verdictSince(claims, askedAbout, 'Asia/Kolkata')).toBe('Tue 3 Nov');
  expect(verdictSince([], askedAbout, 'Asia/Kolkata')).toBe('Tue 10 Nov');
  expect(verdictSince([], [], 'Asia/Kolkata')).toBeUndefined();
});

test('other modes get no verdict instruction', () => {
  const fresh = buildInstructions({ mode: 'fresh', now: new Date(), tz: 'Asia/Kolkata', searchedAlready: true });
  expect(fresh).not.toContain('verdict');
});
