import { beforeEach, expect, test } from 'vitest';
import { DEMO_NOW, demoHistoryDays, saveDemoHistory } from '../../scripts/demo-history';
import { refersToPast, resolveTime } from '../time/resolve';
import { openDb } from './db';
import { recall, recallTerms, topicTerms } from './recall';
import { saveClaims, saveMessage } from './store';

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

test('Postgres chats on 9 Nov and an unrelated chat on 3 Nov stay out of a "last Tuesday ... Postgres" recall', () => {
  const nov9 = new Date('2026-11-09T09:00:00+05:30');
  saveMessage({ conversationId: 'pg-today', role: 'user', content: 'Is Neon Postgres still $19?', at: nov9 });
  const answer = saveMessage({ conversationId: 'pg-today', role: 'assistant', content: 'Neon Launch is $25/month now.', at: nov9 });
  saveClaims(answer, [{ subject: 'Neon', attribute: 'Launch plan price', value: '$25/month', sourceUrl: 'https://neon.com/pricing' }], nov9);
  saveMessage({ conversationId: 'k8s', role: 'user', content: 'Kubernetes or Nomad?', at: new Date('2026-11-03T18:00:00+05:30') });
  const terms = recallTerms(question, '', true);
  expect(claimsFor(terms)).toEqual([
    ['Neon', '2026-11-03'],
    ['Supabase', '2026-11-03'],
    ['Render Postgres', '2026-11-03'],
  ]);
  expect(claimsFor(topicTerms(question)).map(([subject]) => subject)).not.toContain('HubSpot Sales Hub');
});

test('without a date, topic recall keeps all words and falls back to the previous question', () => {
  expect(recallTerms('What did we say about pricing?', '', false)).toEqual(['pricing']);
  expect(recallTerms('And which?', 'Compare Postgres hosting prices', false)).toEqual(['compare', 'postgres', 'hosting', 'prices']);
  expect(recallTerms('What did I ask you on 3 November?', '', true)).toEqual([]);
});

test('the demo banner range comes from the demo history itself', () => {
  expect(demoHistoryDays(tz)).toBe('2 to 6 Nov');
});
