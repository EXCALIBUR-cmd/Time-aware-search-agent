import { randomUUID } from 'node:crypto';
import { classifySource } from '../search/official';
import type { SourceType } from '../search/tavily';
import { getDb } from './db';

export type Role = 'user' | 'assistant';
export type Claim = { subject: string; attribute: string; value: string; sourceUrl?: string | null; sourceType?: SourceType };
export type StoredMessage = { id: string; role: Role; content: string; created_at: string; model: string | null };
export type Conversation = { id: string; title: string; created_at: string; is_demo: 0 | 1 };

const index = (text: string, kind: 'message' | 'claim', recalledMessageId: string, at: string) =>
  getDb()
    .prepare('INSERT INTO memory_fts (text, kind, ref_id, created_at) VALUES (?, ?, ?, ?)')
    .run(text, kind, recalledMessageId, at);

export function saveMessage(m: {
  id?: string;
  conversationId: string;
  role: Role;
  content: string;
  at: Date;
  demo?: boolean;
  answeredByModel?: string;
}): string {
  const db = getDb();
  const id = m.id ?? randomUUID();
  const at = m.at.toISOString();
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO conversations (id, title, created_at, is_demo) VALUES (?, ?, ?, ?)').run(
      m.conversationId,
      m.content.slice(0, 60),
      at,
      m.demo ? 1 : 0,
    );
    db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at, model) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      m.conversationId,
      m.role,
      m.content,
      at,
      m.answeredByModel ?? null,
    );
    index(m.content, 'message', id, at);
  })();
  return id;
}

export function saveClaims(messageId: string, claims: Claim[], at: Date): void {
  const db = getDb();
  const checked = at.toISOString();
  const insert = db.prepare(
    'INSERT INTO claims (id, message_id, subject, attribute, value, source_url, checked_at, source_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (const c of claims) {
      const sourceType = c.sourceType ?? (c.sourceUrl ? classifySource(c.sourceUrl, c.subject) : null);
      insert.run(randomUUID(), messageId, c.subject, c.attribute, c.value, c.sourceUrl ?? null, checked, sourceType);
      index(`${c.subject} ${c.attribute} ${c.value}`, 'claim', messageId, checked);
    }
  })();
}

export const listConversations = () =>
  getDb()
    .prepare('SELECT id, title, created_at, is_demo FROM conversations ORDER BY created_at DESC, rowid DESC')
    .all() as Conversation[];

export const getMessages = (conversationId: string) =>
  getDb()
    .prepare('SELECT id, role, content, created_at, model FROM messages WHERE conversation_id = ? ORDER BY rowid')
    .all(conversationId) as StoredMessage[];

export type UserFact = { key: string; value: string; source_message_id: string | null; updated_at: string };

export function saveUserFacts(facts: { key: string; value: string }[], sourceMessageId: string, at: Date): void {
  const insert = getDb().prepare(
    'INSERT INTO user_facts (key, value, source_message_id, updated_at) VALUES (?, ?, ?, ?)',
  );
  for (const f of facts) insert.run(f.key, f.value, sourceMessageId, at.toISOString());
}

export function listUserFacts(now: Date): UserFact[] {
  const at = now.toISOString();
  return getDb()
    .prepare(
      `SELECT key, value, source_message_id, updated_at FROM user_facts f
       WHERE rowid = (SELECT rowid FROM user_facts WHERE key = f.key AND updated_at <= ?
                      ORDER BY updated_at DESC, rowid DESC LIMIT 1)
       ORDER BY key`,
    )
    .all(at) as UserFact[];
}
