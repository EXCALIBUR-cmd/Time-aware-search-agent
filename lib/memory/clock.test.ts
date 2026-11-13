import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { resolveTime } from '../time/resolve';
import { openDb } from './db';
import { formatMemory } from './format';
import { recall } from './recall';
import { getMessages, listConversations, listUserFacts, saveClaims, saveMessage, saveUserFacts } from './store';

const tz = 'Asia/Kolkata';
const at = (day: number, time = '10:00') => new Date(`2026-11-${String(day).padStart(2, '0')}T${time}:00+05:30`);
const days = (now: Date, ranges: ReturnType<typeof resolveTime>, topicTerms: string[] = []) =>
  recall({ ranges, topicTerms, now }).map((m) => m.created_at.slice(0, 10));

beforeEach(() => {
  openDb(':memory:');
  const nov1 = saveMessage({ conversationId: 'c1', role: 'user', content: 'hi, my name is Maninder', at: at(1) });
  saveMessage({ conversationId: 'c3', role: 'user', content: 'Compare Postgres hosting prices', at: at(3, '09:00') });
  const nov8 = saveMessage({ conversationId: 'c8', role: 'user', content: 'i am a full stack developer, call me Rahul', at: at(8) });
  saveUserFacts([{ key: 'name', value: 'Maninder' }], nov1, at(1));
  saveUserFacts([{ key: 'name', value: 'Rahul' }, { key: 'role', value: 'full stack developer' }], nov8, at(8));
});

test('now = 3 Nov: "what did I ask yesterday" covers only 2 Nov, which has nothing, so "no record"', () => {
  const ranges = resolveTime('what did I ask yesterday', at(3), tz);
  const items = recall({ ranges, topicTerms: [], now: at(3) });
  expect(items).toEqual([]);
  expect(formatMemory(items, ranges, tz)).toContain('No conversations found between 2 Nov 2026 and 2 Nov 2026.');
});

test('now = 3 Nov: a topic search matching the 8 Nov chat returns nothing from 8 Nov', () => {
  expect(days(at(3), [], ['developer', 'stack'])).toEqual([]);
  expect(days(at(12), [], ['developer', 'stack'])).toEqual(['2026-11-08']);
});

test('now = 12 Nov: recall can return the 1, 3 and 8 Nov messages', () => {
  const all = (now: Date) => days(now, resolveTime('everything from 1 November to 8 November', now, tz));
  expect(all(at(12))).toEqual(['2026-11-01', '2026-11-03', '2026-11-08']);
  expect(all(at(3))).toEqual(['2026-11-01', '2026-11-03']);
});

test('now = 3 Nov: a name set on 1 Nov and changed on 8 Nov is still the 1 Nov name', () => {
  expect(listUserFacts(at(3)).map((f) => [f.key, f.value])).toEqual([['name', 'Maninder']]);
  expect(listUserFacts(at(12)).map((f) => [f.key, f.value])).toEqual([['name', 'Rahul'], ['role', 'full stack developer']]);
  expect(listUserFacts(new Date('2026-10-31T10:00:00+05:30'))).toEqual([]);
});

test('a resolved range never ends later than now, down to the minute', () => {
  const now = at(3, '10:00');
  const [today] = resolveTime('what did I ask today', now, tz);
  expect(today.end).toEqual(now);
  saveMessage({ conversationId: 'later', role: 'user', content: 'said at 3 Nov 15:00', at: at(3, '15:00') });
  expect(recall({ ranges: [today], topicTerms: [], now }).map((m) => m.content)).toEqual(['Compare Postgres hosting prices']);
});

test('a claim checked after now is not linked yet', () => {
  const answer = saveMessage({ conversationId: 'c3', role: 'assistant', content: 'Neon Launch is $19/month.', at: at(3, '09:01') });
  saveClaims(answer, [{ subject: 'Neon', attribute: 'Launch plan price', value: '$19/month' }], at(3, '09:01'));
  saveClaims(answer, [{ subject: 'Neon', attribute: 'Launch plan price', value: '$25/month' }], at(8));
  const values = (now: Date) => recall({ ranges: [], topicTerms: ['neon'], now }).flatMap((m) => m.claims.map((c) => c.value));
  expect(values(at(3))).toEqual(['$19/month']);
  expect(values(at(12))).toEqual(['$19/month', '$25/month']);
});

test('the sidebar still lists every conversation, whatever the clock says', () => {
  expect(listConversations().map((c) => c.id).sort()).toEqual(['c1', 'c3', 'c8']);
});

test('migration keeps facts from the old one-row-per-key table and then allows history', () => {
  const file = join(tmpdir(), `agent-migration-${process.pid}.db`);
  rmSync(file, { force: true });
  const old = new Database(file);
  old.exec(`CREATE TABLE user_facts (key TEXT PRIMARY KEY, value TEXT NOT NULL, source_message_id TEXT, updated_at TEXT NOT NULL);
            INSERT INTO user_facts VALUES ('name', 'Maninder', NULL, '${at(1).toISOString()}');`);
  old.close();
  const db = openDb(file);
  db.prepare('INSERT INTO user_facts (key, value, updated_at) VALUES (?, ?, ?)').run('name', 'Rahul', at(8).toISOString());
  expect(listUserFacts(at(3)).map((f) => f.value)).toEqual(['Maninder']);
  expect(listUserFacts(at(12)).map((f) => f.value)).toEqual(['Rahul']);
  db.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
});

test('migration adds the model column to a messages table created before it existed', () => {
  const file = join(tmpdir(), `agent-model-migration-${process.pid}.db`);
  rmSync(file, { force: true });
  const old = new Database(file);
  old.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, created_at TEXT NOT NULL);
            CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
              role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL);
            INSERT INTO conversations VALUES ('old', 'an old chat', '${at(1).toISOString()}');
            INSERT INTO messages VALUES ('old-1', 'old', 'assistant', 'an old answer', '${at(1).toISOString()}');`);
  old.close();
  const db = openDb(file);
  saveMessage({ conversationId: 'old', role: 'assistant', content: 'a new answer', at: at(3), answeredByModel: 'small/model' });
  expect(getMessages('old').map((m) => [m.content, m.model])).toEqual([
    ['an old answer', null],
    ['a new answer', 'small/model'],
  ]);
  db.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
});
