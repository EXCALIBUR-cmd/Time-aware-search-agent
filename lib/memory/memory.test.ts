import { beforeEach, expect, test } from 'vitest';
import { resolveTime } from '../time/resolve';
import { openDb } from './db';
import { formatMemory, formatProfile } from './format';
import { recall, recallTerms, topicTerms } from './recall';
import { getMessages, listConversations, listUserFacts, saveClaims, saveMessage, saveUserFacts } from './store';

const tz = 'Asia/Kolkata';
const now = new Date('2026-11-07T10:00:00+05:30');
const nov3 = new Date('2026-11-03T15:30:00+05:30');

beforeEach(() => {
  openDb(':memory:');
  saveMessage({ conversationId: 'pg', role: 'user', content: 'Compare Postgres hosting prices', at: nov3 });
  const answer = saveMessage({ conversationId: 'pg', role: 'assistant', content: 'Neon Launch is $19/month.', at: nov3 });
  saveClaims(answer, [{ subject: 'Neon', attribute: 'Launch plan price', value: '$19/month', sourceUrl: 'https://neon.com/pricing' }], nov3);
});

test('stores conversations and messages in order', () => {
  expect(listConversations().map((c) => c.title)).toEqual(['Compare Postgres hosting prices']);
  expect(getMessages('pg').map((m) => m.role)).toEqual(['user', 'assistant']);
  saveMessage({ conversationId: 'seeded', role: 'user', content: 'demo', at: now, demo: true });
  expect(listConversations().map((c) => [c.id, c.is_demo])).toEqual([['seeded', 1], ['pg', 0]]);
});

test('message and conversation timestamps are the clock they were given, simulated or not', () => {
  const simulated = new Date('2026-11-01T11:23:00+05:30');
  saveMessage({ conversationId: 'sim', role: 'user', content: 'hi, my name is Maninder', at: simulated });
  expect(listConversations().find((c) => c.id === 'sim')?.created_at).toBe(simulated.toISOString());
  expect(getMessages('sim').map((m) => m.created_at)).toEqual([simulated.toISOString()]);
});

test('an answer remembers which model wrote it; a user message has none', () => {
  saveMessage({ conversationId: 'm', role: 'user', content: 'question', at: now });
  saveMessage({ conversationId: 'm', role: 'assistant', content: 'answer', at: now, answeredByModel: 'some/small-model' });
  expect(getMessages('m').map((m) => m.model)).toEqual([null, 'some/small-model']);
  expect(getMessages('pg').map((m) => m.model)).toEqual([null, null]);
});

test('an answer keeps its cited sources for the chips; messages saved without any return none', () => {
  const cited = [{ sourceId: '3', title: 'Pricing | Supabase', url: 'https://supabase.com/pricing', official: true }];
  saveMessage({ conversationId: 's', role: 'assistant', content: 'Pro is $25/month [3].', at: now, sources: cited });
  expect(getMessages('s').map((m) => m.sources)).toEqual([cited]);
  expect(getMessages('pg').map((m) => m.sources)).toEqual([[], []]);
});

test('a conversation keeps its order when the clock moves backwards', () => {
  saveMessage({ conversationId: 'mixed', role: 'user', content: 'first, said today', at: now });
  saveMessage({ conversationId: 'mixed', role: 'user', content: 'second, said on a simulated 1 Nov', at: new Date('2026-11-01T11:23:00+05:30') });
  expect(getMessages('mixed').map((m) => m.content.split(',')[0])).toEqual(['first', 'second']);
});

test('recalls a day with its claims, each carrying a date', () => {
  const ranges = resolveTime('What did I ask you on 3 November?', now, tz);
  const items = recall({ now, ranges, topicTerms: [] });
  expect(items).toHaveLength(2);
  expect(items[1].claims[0].value).toBe('$19/month');
  const block = formatMemory(items, ranges, tz);
  expect(block).toContain('[Tue 3 Nov 2026, 15:30 · "Compare Postgres hosting prices"] user:');
  expect(block).toContain('claim: Neon · Launch plan price = $19/month (source: https://neon.com/pricing, official, checked 3 Nov 2026)');
});

test('a date without topic words returns every message inside the range', () => {
  for (let i = 0; i < 10; i++) saveMessage({ conversationId: 'more', role: 'user', content: `question ${i}`, at: nov3 });
  const text = 'i told that to you on 3rd nov';
  const ranges = resolveTime(text, now, tz);
  expect(recallTerms(text, '', true)).toEqual([]);
  const items = recall({ now, ranges, topicTerms: [] });
  expect(items).toHaveLength(12);
  expect(items.every((m) => m.match === 'date')).toBe(true);
});

test('a date and a topic keep only conversations matching both, including answers that never repeat the topic word', () => {
  saveMessage({ conversationId: 'k8s', role: 'user', content: 'Kubernetes or Nomad?', at: nov3 });
  saveMessage({ conversationId: 'k8s', role: 'assistant', content: 'Nomad is simpler to run.', at: nov3 });
  const ranges = resolveTime('on 3 November', now, tz);
  expect(recall({ now, ranges, topicTerms: ['kubernetes'] }).map((m) => m.content)).toEqual([
    'Kubernetes or Nomad?',
    'Nomad is simpler to run.',
  ]);
});

test('when nothing on the asked dates matches the topic, only the nearest on-topic message comes back and memory says so', () => {
  saveMessage({ conversationId: 'later', role: 'user', content: 'Postgres backups', at: new Date('2026-11-06T10:00:00+05:30') });
  const ranges = resolveTime('on 4 November', now, tz);
  const items = recall({ now, ranges, topicTerms: ['postgres'] });
  expect(items.map((m) => [m.content, m.match])).toEqual([['Compare Postgres hosting prices', 'topic']]);
  const block = formatMemory(items, ranges, tz);
  expect(block).toContain('No conversations on this topic between 4 Nov 2026 and 4 Nov 2026.');
  expect(block).toContain('[Tue 3 Nov 2026, 15:30 · "Compare Postgres hosting prices"] user:');
  expect(block).toContain('do not re-check it now');
  expect(recall({ now, ranges, topicTerms: ['kubernetes'] })).toEqual([]);
});

test('recalls by topic through FTS, including claim text, capped at 8', () => {
  const items = recall({ now, ranges: [], topicTerms: topicTerms('Has the Neon launch plan changed?') });
  expect(items.map((m) => [m.role, m.match])).toContainEqual(['assistant', 'topic']);
  expect(recall({ now, ranges: [], topicTerms: ['kubernetes'] })).toEqual([]);
  for (let i = 0; i < 10; i++) saveMessage({ conversationId: 'more', role: 'user', content: `question ${i}`, at: nov3 });
  expect(recall({ now, ranges: [], topicTerms: ['question'] })).toHaveLength(8);
});

test('topic matches outside the asked dates are left out, and the current conversation is left out', () => {
  saveMessage({ conversationId: 'other', role: 'user', content: 'Postgres backups', at: new Date('2026-11-05T10:00:00+05:30') });
  const items = recall({ now, ranges: resolveTime('on 3 November', now, tz), topicTerms: ['postgres'] });
  expect(items.map((m) => m.match)).toEqual(['date', 'date']);
  expect(formatMemory(recall({ now, ranges: [], topicTerms: ['postgres'] }), [], tz)).toContain('Related past messages, matched by topic:');
  expect(recall({ now, ranges: [], topicTerms: ['postgres'], excludeConversationId: 'pg' }).map((m) => m.content)).toEqual(['Postgres backups']);
});

test('says so when a date has no conversations', () => {
  const ranges = resolveTime('What did I ask you on 1 October?', now, tz);
  expect(formatMemory(recall({ now, ranges, topicTerms: [] }), ranges, tz)).toContain(
    'No conversations found between 1 Oct 2026 and 1 Oct 2026.',
  );
});

test('user facts: the newest value per key wins, by the time it was said', () => {
  const id = getMessages('pg')[0].id;
  expect(formatProfile(listUserFacts(now), tz)).toBe('');
  saveUserFacts([{ key: 'name', value: 'Maninder' }, { key: 'role', value: 'full stack developer' }], id, new Date('2026-11-01T11:23:00+05:30'));
  saveUserFacts([{ key: 'name', value: 'Rahul' }], id, new Date('2026-11-01T18:00:00+05:30'));
  saveUserFacts([{ key: 'name', value: 'Old Name' }], id, new Date('2026-10-01T10:00:00+05:30'));
  expect(listUserFacts(now).map((f) => [f.key, f.value])).toEqual([['name', 'Rahul'], ['role', 'full stack developer']]);
  expect(formatProfile(listUserFacts(now), tz)).toBe(
    '<user_profile>\nname: Rahul (told 1 Nov 2026)\nrole: full stack developer (told 1 Nov 2026)\n</user_profile>',
  );
});
