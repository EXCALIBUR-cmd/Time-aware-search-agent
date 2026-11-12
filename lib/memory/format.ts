import { formatInTimeZone } from 'date-fns-tz';
import { CHARS_PER_TOKEN, TOKEN_BUDGET } from '../agent/budget';
import type { TimeRange } from '../time/resolve';
import type { MemoryItem } from './recall';
import type { UserFact } from './store';

const LONGEST_EXCERPT_CHARS = 1500;
const SHORTEST_EXCERPT_CHARS = 150;
const SHARE_OF_MEMORY_BUDGET_FOR_EXCERPTS = 0.8;
const CHARS_SHARED_BY_ALL_EXCERPTS = TOKEN_BUDGET.memory * CHARS_PER_TOKEN * SHARE_OF_MEMORY_BUDGET_FOR_EXCERPTS;

const day = (d: Date | string, tz: string) => formatInTimeZone(d, tz, 'd MMM yyyy');

export function formatMemory(items: MemoryItem[], ranges: TimeRange[], tz: string): string {
  const evenShare = Math.floor(CHARS_SHARED_BY_ALL_EXCERPTS / Math.max(1, items.length));
  const excerpt = Math.min(LONGEST_EXCERPT_CHARS, Math.max(SHORTEST_EXCERPT_CHARS, evenShare));
  const lines = (match: MemoryItem['match']) =>
    items
      .filter((m) => m.match === match)
      .flatMap((m) => [
        `[${formatInTimeZone(m.created_at, tz, 'EEE d MMM yyyy, HH:mm')} · "${m.title}"] ${m.role}: ${m.content.slice(0, excerpt)}`,
        ...m.claims.map(
          (c) =>
            `  claim: ${c.subject} · ${c.attribute} = ${c.value} (source: ${c.source_url ?? 'none'}, checked ${day(c.checked_at, tz)})`,
        ),
      ]);
  const dated = lines('date');
  const topical = lines('topic');
  const out: string[] = [];
  if (ranges.length) {
    out.push(
      ...(dated.length
        ? dated
        : ranges.map((r) => `No conversations found between ${day(r.start, tz)} and ${day(r.end, tz)}.`)),
    );
  }
  if (topical.length) out.push('Related past messages, matched by topic:', ...topical);
  if (!out.length) out.push('No matching past conversations found.');
  return `<memory>\n${out.join('\n')}\n</memory>`;
}

export function formatProfile(facts: UserFact[], tz: string): string {
  if (!facts.length) return '';
  const lines = facts.map((f) => `${f.key}: ${f.value} (told ${day(f.updated_at, tz)})`);
  return `<user_profile>\n${lines.join('\n')}\n</user_profile>`;
}
