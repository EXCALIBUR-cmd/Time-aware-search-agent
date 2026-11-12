import { z } from 'zod';
import { getConfig } from '../config';

export type SearchResult = { title: string; url: string; content: string; published_date?: string };
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

const timeRange = (days: number) => (days <= 1 ? 'day' : days <= 7 ? 'week' : days <= 31 ? 'month' : 'year');

export async function tavilySearch(query: string, depth: Depth, recencyDays?: number): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getConfig().TAVILY_API_KEY}` },
    body: JSON.stringify({
      query,
      search_depth: depth,
      max_results: 3,
      ...(recencyDays ? { time_range: timeRange(recencyDays) } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Response.parse(await res.json()).results.map((r) => ({
    title: r.title ?? r.url,
    url: r.url,
    content: r.content ?? '',
    ...(r.published_date ? { published_date: r.published_date } : {}),
  }));
}
