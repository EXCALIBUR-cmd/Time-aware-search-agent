import { tool } from 'ai';
import { z } from 'zod';
import { now } from '../config';
import { getDb } from '../memory/db';
import { tavilySearch, type Depth, type SearchResult } from './tavily';

export type NumberedResult = SearchResult & { n: number };

const HOUR = 3_600_000;
const MAX_CHARS = 1500;
const ttl = (query: string) => (/pric|latest|today|news/i.test(query) ? HOUR / 2 : 6 * HOUR);

async function cachedSearch(query: string, depth: Depth, recencyDays: number | undefined, bypassCache: boolean) {
  const db = getDb();
  const key = `${query.trim().toLowerCase().replace(/\s+/g, ' ')}|${depth}|${recencyDays ?? ''}`;
  const hit = db.prepare('SELECT results_json, fetched_at FROM search_cache WHERE query_key = ?').get(key) as
    | { results_json: string; fetched_at: string }
    | undefined;
  if (hit && !bypassCache && Date.now() - Date.parse(hit.fetched_at) < ttl(query)) {
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

export function createWebSearchTool(opts: {
  bypassCache: boolean;
  onStatus: (text: string) => void;
  onResult: (result: NumberedResult) => void;
}) {
  let n = 0;
  const seen = new Set<string>();
  return tool({
    description:
      'Search the web. Pass 1 to 4 queries; they run in parallel. Each result has a number n: cite it as [n].',
    inputSchema: z.object({
      queries: z.array(z.string().min(1)).min(1).max(4),
      recency_days: z.number().int().positive().nullish().describe('Only results from the last N days, e.g. 30 for news'),
      depth: z.enum(['basic', 'advanced']).nullish(),
    }),
    execute: async ({ queries, recency_days, depth }) => {
      opts.onStatus(`Searching: ${queries.join(', ')}…`);
      const errors: string[] = [];
      const batches = await Promise.all(
        queries.map((q) =>
          cachedSearch(q, depth ?? 'basic', recency_days ?? undefined, opts.bypassCache).catch((e: unknown) => {
            errors.push(`${q}: ${e instanceof Error ? e.message : String(e)}`);
            return [] as SearchResult[];
          }),
        ),
      );
      const results: NumberedResult[] = [];
      for (const r of batches.flat()) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        const numbered = { ...r, n: ++n, content: r.content.slice(0, MAX_CHARS) };
        results.push(numbered);
        opts.onResult(numbered);
      }
      return { results, errors, searched_at: now().toISOString() };
    },
  });
}
