import { formatInTimeZone } from 'date-fns-tz';
import { z } from 'zod';
import type { MemoryClaim } from '../memory/recall';
import type { NumberedResult } from '../search/web-search-tool';
import { distinctiveWords } from '../search/passages';
import { compareValues, containsValue, normaliseQuoteText, type Changed } from './values';

export type ClaimRow = MemoryClaim & { id: string };
export type CheckedRow = ClaimRow & { now: string | null; changed: Changed; source?: NumberedResult; quote?: string };

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
- now_value is the current value as the source states it. quote is the exact sentence or table row that states it, copied character for character from one source; it must contain the figure in now_value. For a table, copy exactly one whole row, including its | characters, and nothing from other rows.
- source_url is the URL of that source. Prefer sources marked (official).
- If no source states the value, use null for now_value, quote and source_url. Never guess.`;

const sameThingKey = (claim: MemoryClaim) =>
  [...new Set(distinctiveWords(`${claim.subject} ${claim.attribute}`))].sort().join(' ');

export function claimsToCompare(claims: MemoryClaim[]): ClaimRow[] {
  const merged = new Map<string, MemoryClaim>();
  for (const claim of claims) {
    const key = sameThingKey(claim);
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, claim);
      continue;
    }
    const newest = claim.checked_at > seen.checked_at ? claim : seen;
    const shortestName = claim.subject.length < seen.subject.length ? claim : seen;
    merged.set(key, { ...newest, subject: shortestName.subject, attribute: shortestName.attribute });
  }
  return [...merged.values()].slice(0, MAX_ROWS).map((claim, i) => ({ ...claim, id: `c${i + 1}` }));
}

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

function verifiedValue(value: ExtractedValue | undefined, sources: NumberedResult[]) {
  if (!value?.now_value || !value.quote || !value.source_url) return undefined;
  const source = sources.find((candidate) => candidate.url === value.source_url);
  if (!source) return undefined;
  if (!quoteAppearsIn(source.content, value.quote) || !containsValue(value.quote, value.now_value)) return undefined;
  return { now: value.now_value, source, quote: value.quote };
}

export function checkRows(rows: ClaimRow[], extracted: ExtractedValue[], sources: NumberedResult[]): CheckedRow[] {
  return rows.map((row) => {
    const verified = verifiedValue(extracted.find((value) => value.claim_id === row.id), sources);
    if (!verified) return { ...row, now: null, changed: 'unknown' };
    return { ...row, ...verified, changed: compareValues(row.value, verified.now) };
  });
}

const counted = (n: number, noun: string) => `${NUMBER_WORDS[n] ?? n} ${noun}${n === 1 ? '' : 's'}`;

export function renderVerdict(rows: CheckedRow[], since: string): string {
  const changed = rows.filter((row) => row.changed === 'yes').length;
  const unconfirmed = rows.filter((row) => row.changed === 'unknown').length;
  const lead = changed ? `${counted(changed, 'price')} changed since ${since}` : `Nothing has changed since ${since}`;
  const caveat = unconfirmed ? `; ${counted(unconfirmed, 'price').toLowerCase()} couldn't be confirmed` : '';
  return `**${lead}${caveat}.**`;
}

const CHANGED_LABEL: Record<Changed, string> = { yes: 'Yes', no: 'No', unknown: 'Unknown' };

export function renderTable(rows: CheckedRow[], tz: string): string {
  const cell = (text: string) => text.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const lines = rows.map((row) => {
    const then = `${row.value} (${formatInTimeZone(row.checked_at, tz, 'd MMM')})`;
    const now = row.now ?? "Couldn't confirm";
    const source = row.source ? `[${row.source.n}]${row.source.sourceType === 'third_party' ? ' (third-party source)' : ''}` : '—';
    return `| ${cell(`${row.subject} · ${row.attribute}`)} | ${cell(then)} | ${cell(now)} | ${CHANGED_LABEL[row.changed]} | ${source} |`;
  });
  return ['| Subject | Then | Now | Changed? | Source |', '| --- | --- | --- | --- | --- |', ...lines].join('\n');
}

export function renderSources(rows: CheckedRow[]): string {
  const cited = [...new Map(rows.flatMap((row) => (row.source ? [[row.source.n, row.source] as const] : []))).values()];
  if (!cited.length) return '';
  return ['**Sources**', ...cited.sort((a, b) => a.n - b.n).map((source) => `[${source.n}] [${source.title}](${source.url})`)].join('\n');
}

export function atMostTwoSentences(text: string): string {
  const prose = text
    .split('\n')
    .filter((line) => !/^\s*(\||#)/.test(line))
    .join(' ');
  return (prose.match(/[^.!?]+[.!?]+/g) ?? []).slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
}
