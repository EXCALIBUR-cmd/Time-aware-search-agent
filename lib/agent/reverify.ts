import { formatInTimeZone } from 'date-fns-tz';
import { z } from 'zod';
import type { MemoryClaim } from '../memory/recall';
import type { NumberedResult } from '../search/web-search-tool';
import { mergeSameClaims } from '../memory/claims';
import { pageTypeRank } from '../search/reverify-search';
import { compareValues, containsValue, normaliseQuoteText, type Changed } from './values';

export type ClaimRow = MemoryClaim & { id: string };
type Verified = { now: string; source: NumberedResult; quote: string };
export type CheckedRow = ClaimRow & {
  now: string | null;
  changed: Changed;
  source?: NumberedResult;
  quote?: string;
  conflict?: [Verified, Verified];
};

const MAX_ROWS = 12;
const NUMBER_WORDS = ['Nothing', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

const Extraction = z.object({
  values: z.array(
    z.object({
      claim_id: z.string(),
      now_value: z.coerce.string().nullable(),
      quote: z.string().nullish(),
      source_url: z.string().nullish(),
    }),
  ),
});
export type ExtractedValue = z.infer<typeof Extraction>['values'][number];

export const EXTRACTION_SYSTEM = `You check stored claims against fetched sources. For every claim, find its current value in the sources.
Reply with JSON only: {"values":[{"claim_id":"c1","now_value":"$5/month","quote":"...","source_url":"https://..."}]}
- A source may word a claim differently (for example "Postgres storage" may appear as "Volume Storage" in a plan table); match by meaning.
- now_value is the current value as the source states it. quote is the exact sentence or table row that states it, copied character for character from one source; it must contain the figure in now_value. Tables are given one row per line, each cell prefixed by its column header, for example "Hobby | Volume Storage: 5 GB | Price: $5/mo". To quote a table, copy one such line, or the cells you need from it in their order, and nothing from other lines.
- source_url is the URL of that source. Sources are listed most authoritative first; prefer sources marked (official).
- When more than one source states a claim's value, return one entry per source, all with the same claim_id.
- If no source states the value, use null for now_value, quote and source_url. Never guess.`;

export const claimsToCompare = (claims: MemoryClaim[]): ClaimRow[] =>
  mergeSameClaims(claims)
    .slice(0, MAX_ROWS)
    .map((claim, i) => ({ ...claim, id: `c${i + 1}` }));

export function extractionPrompt(rows: ClaimRow[], sources: NumberedResult[]): string {
  const claims = rows.map((row) => `${row.id} · ${row.subject} · ${row.attribute} · was ${row.value}`);
  const label = (source: NumberedResult) => (source.sourceType === 'third_party' ? '(third-party source)' : '(official)');
  const evidence = sources.map((source) => `[${source.n}] ${label(source)} ${source.url}\n${source.content}`);
  return `Claims:\n${claims.join('\n')}\n\nSources:\n${evidence.join('\n\n')}`;
}

export const parseExtraction = (modelOutput: string): ExtractedValue[] =>
  Extraction.parse(JSON.parse(modelOutput.match(/\{[\s\S]*\}/)?.[0] ?? '')).values;

function cellsInOneRow(sourceText: string, cells: string[]): boolean {
  return sourceText.split('\n').some((line) => {
    const row = normaliseQuoteText(line);
    let from = 0;
    return cells.every((cell) => {
      const at = row.indexOf(cell, from);
      from = at + cell.length;
      return at !== -1;
    });
  });
}

export function quoteAppearsIn(sourceText: string, quote: string): boolean {
  const normalisedQuote = normaliseQuoteText(quote);
  if (normaliseQuoteText(sourceText).includes(normalisedQuote)) return true;
  const cells = normalisedQuote.split('|').map((cell) => cell.trim()).filter(Boolean);
  return normalisedQuote.includes('|') && cells.length > 0 && cellsInOneRow(sourceText, cells);
}

function verifiedValue(value: ExtractedValue, sources: NumberedResult[]): Verified | undefined {
  if (!value.now_value || !value.quote || !value.source_url) return undefined;
  const source = sources.find((candidate) => candidate.url === value.source_url);
  if (!source) return undefined;
  if (!quoteAppearsIn(source.content, value.quote) || !containsValue(value.quote, value.now_value)) return undefined;
  return { now: value.now_value, source, quote: value.quote };
}

const authority = (value: Verified) => [value.source.sourceType === 'third_party' ? 1 : 0, pageTypeRank(value.source.url), value.source.n];

function byAuthority(a: Verified, b: Verified): number {
  const [left, right] = [authority(a), authority(b)];
  return left.map((rank, i) => rank - right[i]).find((difference) => difference !== 0) ?? 0;
}

export function checkRows(rows: ClaimRow[], extracted: ExtractedValue[], sources: NumberedResult[]): CheckedRow[] {
  return rows.map((row) => {
    const verified = extracted
      .filter((value) => value.claim_id === row.id)
      .map((value) => verifiedValue(value, sources))
      .filter((value): value is Verified => value !== undefined)
      .sort(byAuthority);
    if (!verified.length) return { ...row, now: null, changed: 'unknown' };
    const official = verified.filter((value) => value.source.sourceType !== 'third_party');
    const disagreeing = official.find((value) => compareValues(official[0].now, value.now) === 'yes');
    if (disagreeing) return { ...row, now: null, changed: 'unknown', conflict: [official[0], disagreeing] };
    const best = verified[0];
    return { ...row, ...best, changed: compareValues(row.value, best.now) };
  });
}

const counted = (n: number, noun: string) => `${NUMBER_WORDS[n] ?? n} ${noun}${n === 1 ? '' : 's'}`;

export function renderVerdict(rows: CheckedRow[], since: string): string {
  const changed = rows.filter((row) => row.changed === 'yes').length;
  const unconfirmed = rows.filter((row) => row.changed === 'unknown' && !row.conflict).length;
  const conflicting = rows.filter((row) => row.conflict).length;
  const confirmed = rows.length - unconfirmed - conflicting;
  const mostAreUnconfirmed = rows.length > 0 && confirmed * 2 <= rows.length;
  const leadWithTheCount = !changed && mostAreUnconfirmed;
  const amount = (n: number) => (leadWithTheCount ? String(n) : counted(n, 'price').toLowerCase());
  const caveats = [
    unconfirmed ? `${amount(unconfirmed)} couldn't be confirmed` : '',
    conflicting ? `${amount(conflicting)} ${conflicting === 1 ? 'has' : 'have'} conflicting sources` : '',
  ].filter(Boolean);
  const lead = leadWithTheCount
    ? `${confirmed} of ${rows.length} prices confirmed unchanged`
    : changed
      ? `${counted(changed, 'price')} changed since ${since}`
      : `Nothing has changed since ${since}`;
  return `**${[lead, ...caveats].join('; ')}.**`;
}

const CHANGED_LABEL: Record<Changed, string> = { yes: 'Yes', no: 'No', unknown: 'Unknown' };

export function renderTable(rows: CheckedRow[], tz: string): string {
  const cell = (text: string) => text.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const lines = rows.map((row) => {
    const then = `${row.value} (${formatInTimeZone(row.checked_at, tz, 'd MMM')})`;
    const [first, second] = row.conflict ?? [];
    const now = first && second
      ? `Conflicting sources: ${first.now} (${first.source.url}) vs ${second.now} (${second.source.url})`
      : (row.now ?? "Couldn't confirm");
    const source = first && second
      ? `[${first.source.n}], [${second.source.n}]`
      : row.source
        ? `[${row.source.n}]${row.source.sourceType === 'third_party' ? ' (third-party source)' : ''}`
        : '—';
    return `| ${cell(`${row.subject} · ${row.attribute}`)} | ${cell(then)} | ${cell(now)} | ${CHANGED_LABEL[row.changed]} | ${source} |`;
  });
  return ['| Subject | Then | Now | Changed? | Source |', '| --- | --- | --- | --- | --- |', ...lines].join('\n');
}

export function renderSources(rows: CheckedRow[]): string {
  const citedBy = (row: CheckedRow) => [row.source, ...(row.conflict ?? []).map((value) => value.source)];
  const cited = [
    ...new Map(rows.flatMap(citedBy).flatMap((source) => (source ? [[source.n, source] as const] : []))).values(),
  ];
  if (!cited.length) return '';
  return ['**Sources**', ...cited.sort((a, b) => a.n - b.n).map((source) => `[${source.n}] [${source.title}](${source.url})`)].join('\n');
}

export function atMostTwoSentences(text: string): string {
  const prose = text
    .split('\n')
    .filter((line) => !/^\s*(\||#)/.test(line))
    .join(' ');
  const sentences = prose.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z"“(])/);
  return sentences.slice(0, 2).join(' ').trim();
}
