import { formatInTimeZone } from 'date-fns-tz';
import { CHARS_PER_TOKEN, TOKEN_BUDGET } from '../agent/budget';
import type { TimeRange } from '../time/resolve';
import type { MemoryItem } from './recall';
import type { UserFact } from './store';

const LONGEST_EXCERPT_CHARS = 1500;
const SHORTEST_EXCERPT_CHARS = 150;
const SHARE_OF_MEMORY_BUDGET_FOR_EXCERPTS = 0.8;
const CHARS_SHARED_BY_ALL_EXCERPTS = TOKEN_BUDGET.memory * CHARS_PER_TOKEN * SHARE_OF_MEMORY_BUDGET_FOR_EXCERPTS;

const SOURCE_TYPE_LABEL = { official: 'official', third_party: 'third-party' } as const;

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
            `  claim: ${c.subject} · ${c.attribute} = ${c.value} (source: ${c.source_url ?? 'none'}${c.source_type ? `, ${SOURCE_TYPE_LABEL[c.source_type]}` : ''}, checked ${day(c.checked_at, tz)})`,
        ),
      ]);
  const dated = lines('date');
  const topical = lines('topic');
  const out: string[] = [];
  if (ranges.length && !dated.length) {
    const nothing = topical.length ? 'No conversations on this topic' : 'No conversations found';
    out.push(...ranges.map((r) => `${nothing} between ${day(r.start, tz)} and ${day(r.end, tz)}.`));
  }
  out.push(...dated);
  if (topical.length && ranges.length) {
    out.push(
      'Nearest past conversation on this topic, outside the dates asked about. Say there was nothing on the asked dates, give this date, and offer to re-check it; do not re-check it now:',
      ...topical,
    );
  } else if (topical.length) {
    out.push('Related past messages, matched by topic:', ...topical);
  }
  if (!out.length) out.push('No matching past conversations found.');
  return `<memory>\n${out.join('\n')}\n</memory>`;
}

export function formatProfile(facts: UserFact[], tz: string): string {
  if (!facts.length) return '';
  const lines = facts.map((f) => `${f.key}: ${f.value} (told ${day(f.updated_at, tz)})`);
  return `<user_profile>\n${lines.join('\n')}\n</user_profile>`;
}
