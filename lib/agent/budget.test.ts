import { expect, test } from 'vitest';
import { bestPassage, isVendorDomainFor, pickResults } from '../search/web-search-tool';
import type { SearchResult } from '../search/tavily';
import {
  BUSY_MESSAGE,
  CHAT_TEMPLATE_TOKENS_PER_REQUEST,
  estimatePromptTokens,
  estimateTokens,
  fitPromptToBudget,
  SEARCH_TOOL_DEFINITION_TOKENS,
  TOKEN_BUDGET,
  userFacingError,
  type PromptParts,
  type Turn,
} from './budget';

const filler = (chars: number) => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(chars / 27)).slice(0, chars);
const WORD = ' apple';
const tokensPerWord = estimateTokens(WORD.repeat(200)) / 200;
const textOfTokens = (tokens: number) => WORD.repeat(Math.floor(tokens / tokensPerWord)).trim();
const longResult = (query: number, rank: number): SearchResult => ({
  title: `Result ${rank} for query ${query}`,
  url: `https://site${query}-${rank}.example/page`,
  content: filler(5000),
});
const emptyPrompt: PromptParts<SearchResult> = { instructions: '', profile: '', memory: '', history: [], userText: '', searchResults: [] };

test('20 long search results get trimmed to 8 within budget', () => {
  const batches = [1, 2, 3, 4].map((query) => ({
    query: `query ${query}`,
    results: [1, 2, 3, 4, 5].map((rank) => longResult(query, rank)),
  }));
  expect(batches.flatMap((b) => b.results)).toHaveLength(20);

  const picked = pickResults(batches);
  expect(picked).toHaveLength(8);
  expect(Math.max(...picked.map((r) => r.content.length))).toBeLessThanOrEqual(602);
  expect(picked.slice(0, 4).map((r) => r.url)).toEqual([1, 2, 3, 4].map((q) => `https://site${q}-1.example/page`));
  expect(estimateTokens(JSON.stringify(picked))).toBeLessThan(TOKEN_BUDGET.searchResults);

  const fitted = fitPromptToBudget({ ...emptyPrompt, searchResults: picked });
  expect(fitted.searchResults).toHaveLength(8);
  expect(estimatePromptTokens(fitted)).toBeLessThanOrEqual(TOKEN_BUDGET.total);
});

test('a long history keeps the newest turns', () => {
  const history: Turn[] = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `turn ${i + 1} ${textOfTokens(290)}`,
  }));
  const fitted = fitPromptToBudget({ ...emptyPrompt, history });
  const keptTurnNumbers = fitted.history.map((turn) => Number(turn.content.split(' ')[1]));
  expect(keptTurnNumbers).toEqual([10, 11, 12]);
  expect(estimateTokens(JSON.stringify(fitted.history))).toBeLessThanOrEqual(TOKEN_BUDGET.history);
});

test('a newest turn that is too long on its own is cut, not dropped', () => {
  const fitted = fitPromptToBudget({ ...emptyPrompt, history: [{ role: 'assistant', content: filler(20_000) }] });
  expect(fitted.history).toHaveLength(1);
  expect(estimateTokens(fitted.history[0].content)).toBeLessThanOrEqual(TOKEN_BUDGET.history);
});

test('memory and profile blocks are cut to their budgets and keep their closing tag', () => {
  const memory = ['<memory>', ...Array.from({ length: 40 }, (_, i) => `item ${i} ${filler(400)}`), '</memory>'].join('\n');
  const fitted = fitPromptToBudget({ ...emptyPrompt, instructions: textOfTokens(600), profile: `<user_profile>\nname: Asha\n${filler(2000)}\n</user_profile>`, memory });
  expect(estimateTokens(fitted.memory)).toBeLessThanOrEqual(TOKEN_BUDGET.memory);
  expect(fitted.memory.startsWith('<memory>\nitem 0')).toBe(true);
  expect(fitted.memory.endsWith('…\n</memory>')).toBe(true);
  expect(estimateTokens(fitted.instructions) + estimateTokens(fitted.profile)).toBeLessThanOrEqual(TOKEN_BUDGET.instructionsAndProfile);
  expect(fitted.profile).toContain('name: Asha');
});

test('still over budget: the lowest-ranked search results go first, then the older turns', () => {
  const searchResults = Array.from({ length: 8 }, (_, i) => longResult(1, i + 1)).map((r) => ({ ...r, content: textOfTokens(320) }));
  const history: Turn[] = [1, 2, 3].map((n) => ({ role: 'user', content: `turn ${n} ${textOfTokens(270)}` }));
  const userText = textOfTokens(1000);

  const overByALittle = fitPromptToBudget({ ...emptyPrompt, instructions: textOfTokens(2000), userText, history, searchResults });
  expect(estimatePromptTokens(overByALittle)).toBeLessThanOrEqual(TOKEN_BUDGET.total);
  expect(overByALittle.searchResults.length).toBeLessThan(8);
  expect(overByALittle.searchResults.map((r) => r.title)[0]).toBe('Result 1 for query 1');
  expect(overByALittle.history).toHaveLength(3);

  const overByALot = fitPromptToBudget({ ...emptyPrompt, instructions: textOfTokens(4300), userText, history, searchResults });
  expect(overByALot.searchResults).toEqual([]);
  expect(overByALot.history.map((turn) => turn.content.slice(0, 6))).toEqual(['turn 3']);
});

test('the official vendor domain is preferred when the query names the product', () => {
  expect(isVendorDomainFor('https://neon.com/pricing', 'Neon Postgres pricing')).toBe(true);
  expect(isVendorDomainFor('https://nextjs.org/blog', 'latest Next.js version')).toBe(true);
  expect(isVendorDomainFor('https://www.g2.com/products/neon/pricing', 'Neon Postgres pricing')).toBe(false);
  expect(isVendorDomainFor('not a url', 'Neon Postgres pricing')).toBe(false);
  const picked = pickResults([
    {
      query: 'Supabase pricing',
      results: [
        { title: 'Review', url: 'https://reviews.example/supabase', content: 'a review' },
        { title: 'Blog', url: 'https://blog.example/supabase-cost', content: 'a blog' },
        { title: 'Other', url: 'https://other.example/x', content: 'other' },
        { title: 'Pricing', url: 'https://supabase.com/pricing', content: 'official' },
      ],
    },
  ]);
  expect(picked.map((r) => r.title)).toEqual(['Pricing', 'Review', 'Blog']);
});

test('a long page is trimmed to the passage with the price, not to its start', () => {
  const page = `${filler(3000)} The Launch plan costs $19/month and the Scale plan $69/month per project. ${filler(3000)}`;
  const passage = bestPassage(page, 'Neon pricing');
  expect(passage.length).toBeLessThanOrEqual(602);
  expect(passage).toContain('$19/month');
  expect(passage.startsWith('…')).toBe(true);
  expect(bestPassage('short page', 'anything')).toBe('short page');
});

test('a rate limit or too-large error becomes a short friendly message; other errors stay as they are', () => {
  const groq429 = 'Failed after 2 attempts. Last error: Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 7200, Requested 1900. Please try again in 8.2s.';
  const groq413 = 'Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 9400.';
  expect(userFacingError(new Error(groq429))).toBe(BUSY_MESSAGE);
  expect(userFacingError(new Error(groq413))).toBe(BUSY_MESSAGE);
  expect(userFacingError(new Error('Missing environment variable(s): GROQ_API_KEY.'))).toBe('Missing environment variable(s): GROQ_API_KEY.');
  const providerErrorThatIsNotAnErrorObject = { message: 'Tool choice is none, but model called a tool', type: 'invalid_request_error' };
  expect(userFacingError(providerErrorThatIsNotAnErrorObject)).toBe('Tool choice is none, but model called a tool');
  expect(userFacingError('plain text failure')).toBe('plain text failure');
});

test('tokens are counted with the o200k encoding, not guessed from the length', () => {
  expect(estimateTokens('')).toBe(0);
  expect(estimateTokens('hello world')).toBe(2);
  const url = 'https://neon.com/pricing?plan=launch&billing=monthly';
  expect(estimateTokens(url)).toBeGreaterThan(Math.ceil(url.length / 8));
  expect(estimateTokens(textOfTokens(500))).toBeLessThanOrEqual(500);
  expect(estimateTokens(textOfTokens(500))).toBeGreaterThan(480);
});

test('a prompt estimate includes what Groq adds to every request: the chat template and the tool definition', () => {
  expect(estimatePromptTokens(emptyPrompt)).toBe(CHAT_TEMPLATE_TOKENS_PER_REQUEST + SEARCH_TOOL_DEFINITION_TOKENS);
  expect(estimatePromptTokens({ ...emptyPrompt, userText: 'hello world' })).toBe(74 + 116 + 2);
});
