import { beforeEach, expect, test } from 'vitest';
import { DEMO_NOW, saveDemoHistory } from '../../scripts/demo-history';
import { refersToPast, resolveTime } from '../time/resolve';
import { openDb } from './db';
import { recall, recallTerms, topicTerms } from './recall';

const tz = 'Asia/Kolkata';
const now = new Date(DEMO_NOW);
const question = 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?';

beforeEach(() => {
  openDb(':memory:');
  saveDemoHistory();
});

const claimsFor = (terms: string[]) => {
  const ranges = resolveTime(question, now, tz);
  return recall({ ranges, topicTerms: terms, now }).flatMap((item) => item.claims.map((claim) => [claim.subject, claim.checked_at.slice(0, 10)]));
};

test('on the demo data, "Last Tuesday ... Postgres hosting" recalls only the 3 Nov Postgres claims', () => {
  const ranges = resolveTime(question, now, tz);
  const terms = recallTerms(question, '', refersToPast(ranges, now));
  expect(terms).toEqual(['postgres', 'hosting']);
  expect(claimsFor(terms)).toEqual([
    ['Neon', '2026-11-03'],
    ['Supabase', '2026-11-03'],
    ['Render Postgres', '2026-11-03'],
  ]);
});

test('every topic word, "pricing" included, was what pulled in the 2 Nov CRM claims', () => {
  const subjects = claimsFor(topicTerms(question)).map(([subject]) => subject);
  expect(subjects).toContain('HubSpot Sales Hub');
});

test('without a date, topic recall keeps all words and falls back to the previous question', () => {
  expect(recallTerms('What did we say about pricing?', '', false)).toEqual(['pricing']);
  expect(recallTerms('And which?', 'Compare Postgres hosting prices', false)).toEqual(['compare', 'postgres', 'hosting', 'prices']);
  expect(recallTerms('What did I ask you on 3 November?', '', true)).toEqual([]);
});
