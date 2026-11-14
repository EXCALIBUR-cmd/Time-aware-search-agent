import { citedNumbers } from '../citations';
import type { NumberedResult } from '../search/web-search-tool';
import { callWithFallback, type ModelPair } from './fallback';
import { askModel } from './reverify-answer';

const ADD_CITATIONS_SYSTEM = `You add citations to an answer that was written from web search results. Return the same answer with an inline [n] after every fact taken from a result, using that result's number n, and end with a "Sources" list of only the results you cited: [n] [title](url). Do not change, add or remove any fact. Return only the answer.`;

const SOURCES_SECTION = /\n\**\s*sources\s*\**:?\s*\**\s*\n[\s\S]*$/i;

export const citesASource = (answer: string, sources: NumberedResult[]) => {
  const cited = citedNumbers(answer.replace(SOURCES_SECTION, ''));
  return sources.some((source) => cited.has(String(source.n)));
};

export function withSourceLinks(answer: string, sources: NumberedResult[]): string {
  if (/https?:\/\//.test(answer)) return answer;
  const body = answer.replace(SOURCES_SECTION, '').trimEnd();
  const cited = citedNumbers(body);
  const used = sources.filter((source) => cited.has(String(source.n)));
  if (!used.length) return answer;
  return `${body}\n\n**Sources**\n${used.map((source) => `[${source.n}] [${source.title}](${source.url})`).join('\n')}`;
}

export async function requireInlineCitations(
  answer: string,
  sources: NumberedResult[],
  models: ModelPair,
  status: (text: string) => void,
): Promise<string> {
  if (!sources.length) return answer;
  let cited = answer;
  if (!citesASource(answer, sources)) {
    status('Adding citations to the answer…');
    const results = sources.map((source) => `[${source.n}] ${source.title}\n${source.url}\n${source.content}`).join('\n\n');
    const revised = await callWithFallback(
      (modelId, isFastModel) =>
        askModel(modelId, isFastModel, ADD_CITATIONS_SYSTEM, `Answer:\n${answer}\n\nSearch results:\n${results}`, `${modelId} add citations`),
      models,
      status,
    )
      .then((reply) => reply.result.trim())
      .catch(() => '');
    if (citesASource(revised, sources)) cited = revised;
    else console.error('[agent] the answer used search but has no inline [n] citations, even after one re-ask');
  }
  return withSourceLinks(cited, sources);
}
