import { tool } from 'ai';
import { z } from 'zod';
import { estimateTokens, takeWithinTokens } from '../agent/budget';
import { now } from '../config';
import { getDb } from '../memory/db';
import { RESULTS_PER_QUERY, tavilySearch, type Depth, type SearchResult } from './tavily';

export type NumberedResult = SearchResult & { n: number };
export type QueryResults = { query: string; results: SearchResult[] };
export type SearchOutcome = { results: NumberedResult[]; errors: string[]; searched_at: string };

const HOUR = 3_600_000;
const MAX_RESULTS_PER_CALL = 8;
const PASSAGE_CHARS = 600;
const PASSAGE_LEAD_IN_CHARS = 80;
const PRICE_HIT_WEIGHT = 2;
const QUERY_TERM_HIT_WEIGHT = 1;
const MIN_VENDOR_LABEL_CHARS = 4;
const FAST_MOVING_TOPIC = /pric|latest|today|news/i;
const PRICE_LIKE =
  /[$€£₹]\s?\d|\/\s?(month|mo|user|seat|year|yr)\b|\bper (month|user|seat|year)\b|\b(free|hobby|starter|launch|basic|pro|team|growth|scale|business|premium|enterprise) (plan|tier)\b/gi;
const GENERIC_HOST_LABELS = new Set(['www', 'docs', 'blog', 'help', 'support', 'news', 'pricing', 'community', 'forum']);
const SEARCH_BUDGET_USED_UP = 'The search budget for this turn is used up: answer from the results you already have.';

const cacheLifetime = (query: string) => (FAST_MOVING_TOPIC.test(query) ? HOUR / 2 : 6 * HOUR);
const wordsOf = (query: string) => query.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function hostLabels(url: string): string[] {
  try {
    return new URL(url).hostname.toLowerCase().split('.').slice(0, -1);
  } catch {
    return [];
  }
}

export function isVendorDomainFor(url: string, query: string): boolean {
  const queryWithoutSeparators = wordsOf(query).join('');
  return hostLabels(url).some(
    (label) =>
      label.length >= MIN_VENDOR_LABEL_CHARS && !GENERIC_HOST_LABELS.has(label) && queryWithoutSeparators.includes(label),
  );
}

export function bestPassage(content: string, query: string, maxChars = PASSAGE_CHARS): string {
  if (content.length <= maxChars) return content;
  const lowerCased = content.toLowerCase();
  const hits = [...content.matchAll(PRICE_LIKE)].map((match) => ({ at: match.index ?? 0, weight: PRICE_HIT_WEIGHT }));
  for (const term of wordsOf(query).filter((word) => word.length > 2)) {
    for (let at = lowerCased.indexOf(term); at !== -1; at = lowerCased.indexOf(term, at + term.length)) {
      hits.push({ at, weight: QUERY_TERM_HIT_WEIGHT });
    }
  }
  if (!hits.length) return `${content.slice(0, maxChars)}…`;
  const lastPossibleStart = content.length - maxChars;
  const candidateStarts = [
    ...new Set(hits.map((hit) => Math.max(0, Math.min(hit.at - PASSAGE_LEAD_IN_CHARS, lastPossibleStart)))),
  ].sort((a, b) => a - b);
  const weightInWindow = (start: number) =>
    hits.reduce((sum, hit) => (hit.at >= start && hit.at < start + maxChars ? sum + hit.weight : sum), 0);
  const start = candidateStarts.reduce((best, candidate) => (weightInWindow(candidate) > weightInWindow(best) ? candidate : best));
  return `${start > 0 ? '…' : ''}${content.slice(start, start + maxChars)}${start < lastPossibleStart ? '…' : ''}`;
}

export function pickResults(batches: QueryResults[], alreadyShown: ReadonlySet<string> = new Set()): SearchResult[] {
  const rankedPerQuery = batches.map(({ query, results }) => {
    const fromVendor = results.filter((result) => isVendorDomainFor(result.url, query));
    const fromElsewhere = results.filter((result) => !isVendorDomainFor(result.url, query));
    return [...fromVendor, ...fromElsewhere]
      .slice(0, RESULTS_PER_QUERY)
      .map((result) => ({ ...result, content: bestPassage(result.content, query) }));
  });
  const picked: SearchResult[] = [];
  const urls = new Set(alreadyShown);
  for (let rank = 0; rank < RESULTS_PER_QUERY; rank++) {
    for (const ranked of rankedPerQuery) {
      const result = ranked[rank];
      if (!result || urls.has(result.url) || picked.length === MAX_RESULTS_PER_CALL) continue;
      urls.add(result.url);
      picked.push(result);
    }
  }
  return picked;
}

async function cachedSearch(query: string, depth: Depth, recencyDays: number | undefined, bypassCache: boolean) {
  const db = getDb();
  const key = `${query.trim().toLowerCase().replace(/\s+/g, ' ')}|${depth}|${recencyDays ?? ''}`;
  const hit = db.prepare('SELECT results_json, fetched_at FROM search_cache WHERE query_key = ?').get(key) as
    | { results_json: string; fetched_at: string }
    | undefined;
  const ageByRealClock = hit ? Date.now() - Date.parse(hit.fetched_at) : Infinity;
  if (hit && !bypassCache && ageByRealClock < cacheLifetime(query)) {
    return JSON.parse(hit.results_json) as SearchResult[];
  }
  const results = await tavilySearch(query, depth, recencyDays);
  db.prepare('INSERT OR REPLACE INTO search_cache (query_key, results_json, fetched_at) VALUES (?, ?, ?)').run(
    key,
    JSON.stringify(results),
    new Date().toISOString(),
  );
  return results;
}

export function formatSearchResults(outcome: SearchOutcome): string {
  const results = outcome.results.map((r) => `[${r.n}] ${r.title}\n${r.url}\n${r.content}`);
  const errors = outcome.errors.map((error) => `Search problem: ${error}`);
  const body = results.length ? results.join('\n\n') : 'No results.';
  return [`<search_results searched_at="${outcome.searched_at}">`, body, ...errors, '</search_results>'].join('\n');
}

export function createSearchSession(opts: {
  bypassCache: boolean;
  tokenBudgetForTurn: number;
  onStatus: (text: string) => void;
  onResult: (result: NumberedResult) => void;
}) {
  let citationNumberWithinTurn = 0;
  let tokensLeftThisTurn = opts.tokenBudgetForTurn;
  const shownUrls = new Set<string>();

  async function search(queries: string[], depth: Depth = 'basic', recencyDays?: number): Promise<SearchOutcome> {
    opts.onStatus(`Searching: ${queries.join(', ')}…`);
    const errors: string[] = [];
    const searchOrRecordFailure = (query: string): Promise<QueryResults> =>
      cachedSearch(query, depth, recencyDays, opts.bypassCache)
        .then((results) => ({ query, results }))
        .catch((e: unknown) => {
          errors.push(`${query}: ${e instanceof Error ? e.message : String(e)}`);
          return { query, results: [] };
        });
    const picked = pickResults(await Promise.all(queries.map(searchOrRecordFailure)), shownUrls);
    const withinBudget = takeWithinTokens(picked, tokensLeftThisTurn);
    const results = withinBudget.map((result) => ({ ...result, n: ++citationNumberWithinTurn }));
    tokensLeftThisTurn -= estimateTokens(JSON.stringify(results));
    if (results.length < picked.length) errors.push(SEARCH_BUDGET_USED_UP);
    for (const result of results) {
      shownUrls.add(result.url);
      opts.onResult(result);
    }
    return { results, errors, searched_at: now().toISOString() };
  }

  const followUpTool = tool({
    description:
      'Search the web. Pass 1 to 4 queries; they run in parallel. Each result has a number n: cite it as [n].',
    inputSchema: z.object({
      queries: z.array(z.string().min(1)).min(1).max(4),
      recency_days: z.number().int().positive().nullish().describe('Only results from the last N days, e.g. 30 for news'),
      depth: z.enum(['basic', 'advanced']).nullish(),
    }),
    execute: ({ queries, recency_days, depth }) => search(queries, depth ?? 'basic', recency_days ?? undefined),
  });

  return { search, followUpTool };
}
