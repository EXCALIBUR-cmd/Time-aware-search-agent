import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbPath } from '../config';

const USER_FACTS = `
CREATE TABLE IF NOT EXISTS user_facts (
  key TEXT NOT NULL,                  -- name, role, location, preference_<topic>
  value TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id),
  updated_at TEXT NOT NULL            -- when the user said it
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT NOT NULL,           -- ISO 8601, UTC
  is_demo INTEGER NOT NULL DEFAULT 0  -- 1 for seeded demo history
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
  message_id TEXT NOT NULL REFERENCES messages(id),  -- the assistant answer it came from
  subject TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT,
  checked_at TEXT NOT NULL            -- when the source was read
);
CREATE INDEX IF NOT EXISTS idx_claims_subject ON claims(subject);
CREATE TABLE IF NOT EXISTS search_cache (
  query_key TEXT PRIMARY KEY,         -- normalised query
  results_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
${USER_FACTS}
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  text, kind UNINDEXED, ref_id UNINDEXED, created_at UNINDEXED
);`;

let db: Database.Database | undefined;

export function openDb(file = dbPath()): Database.Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const columns = db.pragma('table_info(conversations)') as { name: string }[];
  if (!columns.some((c) => c.name === 'is_demo')) {
    db.exec('ALTER TABLE conversations ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0');
  }
  const factColumns = db.pragma('table_info(user_facts)') as { name: string; pk: number }[];
  if (factColumns.some((c) => c.name === 'key' && c.pk > 0)) {
    const opened = db;
    opened.transaction(() =>
      opened.exec(`
        ALTER TABLE user_facts RENAME TO user_facts_old;
        ${USER_FACTS}
        INSERT INTO user_facts SELECT key, value, source_message_id, updated_at FROM user_facts_old;
        DROP TABLE user_facts_old;`),
    )();
  }
  return db;
}

export const getDb = (): Database.Database => db ?? openDb();
