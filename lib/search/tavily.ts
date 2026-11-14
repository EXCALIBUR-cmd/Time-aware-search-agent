import { z } from 'zod';
import { getConfig } from '../config';

export type SourceType = 'official' | 'third_party';
export type SearchResult = {
  title: string;
  url: string;
  content: string;
  published_date?: string;
  sourceType?: SourceType;
};
export type Depth = 'basic' | 'advanced';

const Response = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
});

export const RESULTS_PER_QUERY = 3;

const timeRange = (days: number) => (days <= 1 ? 'day' : days <= 7 ? 'week' : days <= 31 ? 'month' : 'year');

const ExtractResponse = z.object({ results: z.array(z.object({ url: z.string(), raw_content: z.string().nullish() })) });

async function callTavily(endpoint: 'search' | 'extract', body: object): Promise<unknown> {
  const res = await fetch(`https://api.tavily.com/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getConfig().TAVILY_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tavily ${endpoint} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function tavilyExtract(url: string): Promise<string | undefined> {
  const page = ExtractResponse.parse(await callTavily('extract', { urls: [url], extract_depth: 'basic' }));
  return page.results[0]?.raw_content ?? undefined;
}

export async function tavilySearch(
  query: string,
  depth: Depth,
  recencyDays?: number,
  includeDomains?: string[],
): Promise<SearchResult[]> {
  const body = {
    query,
    search_depth: depth,
    max_results: RESULTS_PER_QUERY,
    ...(recencyDays ? { time_range: timeRange(recencyDays) } : {}),
    ...(includeDomains?.length ? { include_domains: includeDomains } : {}),
  };
  return Response.parse(await callTavily('search', body)).results.map((r) => ({
    title: r.title ?? r.url,
    url: r.url,
    content: r.content ?? '',
    ...(r.published_date ? { published_date: r.published_date } : {}),
  }));
}
