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

const NOT_A_TOPIC = new Set(
  'pricing price prices priced cost costs plan plans tier tiers monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec yesterday week month year'.split(
    ' ',
  ),
);

const DAY_NUMBER = /^\d+(st|nd|rd|th)?$/;

export function recallTerms(text: string, previousQuestion: string, asksAboutADate: boolean): string[] {
  if (asksAboutADate) return topicTerms(text).filter((term) => !NOT_A_TOPIC.has(term) && !DAY_NUMBER.test(term));
  const own = topicTerms(text);
  return own.length ? own : topicTerms(previousQuestion);
}

const IN_RANGE = `SELECT id FROM messages WHERE created_at BETWEEN @start AND @end AND created_at <= @now`;
const ON_TOPIC_IN_RANGE = `${IN_RANGE} AND conversation_id IN (
  SELECT conversation_id FROM messages WHERE created_at BETWEEN @start AND @end
  AND id IN (SELECT ref_id FROM memory_fts WHERE memory_fts MATCH @match))`;

function inRangeIds(ranges: TimeRange[], match: string, now: string): string[] {
  const query = getDb().prepare(`${match ? ON_TOPIC_IN_RANGE : IN_RANGE} ORDER BY created_at, rowid LIMIT @limit`);
  return ranges.flatMap((r) =>
    (
      query.all({ start: r.start.toISOString(), end: r.end.toISOString(), now, limit: MAX_DATE_ITEMS, ...(match ? { match } : {}) }) as {
        id: string;
      }[]
    ).map((row) => row.id),
  );
}

function nearestOnTopic(ranges: TimeRange[], match: string, now: string, excludeConversationId: string): string | undefined {
  const hits = getDb()
    .prepare(
      `SELECT id, created_at FROM messages WHERE created_at <= ? AND conversation_id != ?
       AND id IN (SELECT ref_id FROM memory_fts WHERE memory_fts MATCH ?)`,
    )
    .all(now, excludeConversationId, match) as { id: string; created_at: string }[];
  const distance = (at: string) =>
    Math.min(
      ...ranges.map((r) => {
        const t = Date.parse(at);
        return t < r.start.getTime() ? r.start.getTime() - t : Math.max(0, t - r.end.getTime());
      }),
    );
  return hits.sort((a, b) => distance(a.created_at) - distance(b.created_at))[0]?.id;
}

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

  const match = q.topicTerms.map((t) => `"${t}"`).join(' OR ');
  if (q.ranges.length) {
    for (const id of inRangeIds(q.ranges, match, now)) add(id, 'date');
    if (match && !items.length) {
      const nearest = nearestOnTopic(q.ranges, match, now, q.excludeConversationId ?? '');
      if (nearest) add(nearest, 'topic');
    }
  } else if (match) {
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
