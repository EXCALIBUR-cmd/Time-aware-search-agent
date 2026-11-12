import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbPath } from '../config';

const USER_FACTS = `
CREATE TABLE IF NOT EXISTS user_facts (
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id),
  updated_at TEXT NOT NULL
);`;

const IDEMPOTENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  subject TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_subject ON claims(subject);
CREATE TABLE IF NOT EXISTS search_cache (
  query_key TEXT PRIMARY KEY,
  results_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
${USER_FACTS}
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  text, kind UNINDEXED, ref_id UNINDEXED, created_at UNINDEXED
);`;

let db: Database.Database | undefined;

function addDemoFlagToOlderDatabases(opened: Database.Database): void {
  const columns = opened.pragma('table_info(conversations)') as { name: string }[];
  if (columns.some((c) => c.name === 'is_demo')) return;
  opened.exec('ALTER TABLE conversations ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0');
}

function keepUserFactHistoryInOlderDatabases(opened: Database.Database): void {
  const columns = opened.pragma('table_info(user_facts)') as { name: string; pk: number }[];
  const holdsOnlyOneRowPerKey = columns.some((c) => c.name === 'key' && c.pk > 0);
  if (!holdsOnlyOneRowPerKey) return;
  opened.transaction(() =>
    opened.exec(`
      ALTER TABLE user_facts RENAME TO user_facts_old;
      ${USER_FACTS}
      INSERT INTO user_facts SELECT key, value, source_message_id, updated_at FROM user_facts_old;
      DROP TABLE user_facts_old;`),
  )();
}

export function openDb(file = dbPath()): Database.Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const opened = new Database(file);
  db = opened;
  opened.pragma('journal_mode = WAL');
  opened.pragma('foreign_keys = ON');
  opened.exec(IDEMPOTENT_SCHEMA);
  addDemoFlagToOlderDatabases(opened);
  keepUserFactHistoryInOlderDatabases(opened);
  return opened;
}

export const getDb = (): Database.Database => db ?? openDb();
