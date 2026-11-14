import type { TimeRange } from '../time/resolve';
import { classifySource } from '../search/official';
import type { SourceType } from '../search/tavily';
import { keepOneClaimPerGroup } from './claims';
import { getDb } from './db';
import type { Role } from './store';

export type MemoryClaim = {
  subject: string;
  attribute: string;
  value: string;
  source_url: string | null;
  checked_at: string;
  source_type: SourceType | null;
};
export type MemoryItem = {
  id: string;
  role: Role;
  content: string;
  created_at: string;
  title: string;
  match: 'date' | 'topic';
  claims: MemoryClaim[];
};

const MAX_TOPIC_ITEMS = 8;
const MAX_DATE_ITEMS = 50;
const STOP = new Set(
  'the and what did you ask asked about has any have was were your still today since then changed change that this with for our are which those discuss discussed say said tell told last week answer correct when how can could would from there been does anything something earlier before previously remember talk talked conversation chat know'.split(
    ' ',
  ),
);

const withSourceType = (claim: MemoryClaim): MemoryClaim => ({
  ...claim,
  source_type: claim.source_type ?? (claim.source_url ? classifySource(claim.source_url, claim.subject) : null),
});

const officialFirst = (claims: MemoryClaim[]) =>
  claims.map(withSourceType).sort((a, b) => Number(b.source_type === 'official') - Number(a.source_type === 'official'));

export const topicTerms = (text: string): string[] =>
  [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length > 2 && !STOP.has(w));

export function recall(q: {
  ranges: TimeRange[];
  topicTerms: string[];
  now: Date;
  excludeConversationId?: string;
}): MemoryItem[] {
  const db = getDb();
  const now = q.now.toISOString();
  const load = db.prepare(
    `SELECT m.id, m.role, m.content, m.created_at, c.title FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = ? AND m.conversation_id != ? AND m.created_at <= ?`,
  );
  const claims = db.prepare(
    'SELECT subject, attribute, value, source_url, checked_at, source_type FROM claims WHERE message_id = ? AND checked_at <= ?',
  );
  const items: MemoryItem[] = [];
  const seen = new Set<string>();
  const add = (id: string, match: MemoryItem['match']): boolean => {
    if (seen.has(id)) return false;
    const m = load.get(id, q.excludeConversationId ?? '', now) as Omit<MemoryItem, 'match' | 'claims'> | undefined;
    if (!m) return false;
    seen.add(id);
    items.push({ ...m, match, claims: officialFirst(claims.all(id, now) as MemoryClaim[]) });
    return true;
  };

  const inRange = db.prepare(
    'SELECT id FROM messages WHERE created_at BETWEEN ? AND ? AND created_at <= ? ORDER BY created_at, rowid LIMIT ?',
  );
  for (const r of q.ranges) {
    const rows = inRange.all(r.start.toISOString(), r.end.toISOString(), now, MAX_DATE_ITEMS) as { id: string }[];
    for (const row of rows) add(row.id, 'date');
  }

  if (q.topicTerms.length) {
    const match = q.topicTerms.map((t) => `"${t}"`).join(' OR ');
    const hits = db
      .prepare(
        'SELECT ref_id FROM memory_fts WHERE memory_fts MATCH ? AND created_at <= ? ORDER BY rank, created_at DESC LIMIT 60',
      )
      .all(match, now) as { ref_id: string }[];
    let topical = 0;
    for (const h of hits) {
      if (topical === MAX_TOPIC_ITEMS) break;
      if (add(h.ref_id, 'topic')) topical++;
    }
  }
  const askedUpTo = q.ranges.map((range) => range.end.toISOString()).sort().at(-1);
  return keepOneClaimPerGroup(items, askedUpTo);
}
