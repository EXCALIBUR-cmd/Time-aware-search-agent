import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

export const TOKEN_BUDGET = {
  total: 6000,
  instructionsAndProfile: 800,
  memory: 1200,
  searchResults: 3000,
  history: 1000,
} as const;

export const CHARS_PER_TOKEN = 4;
export const CHAT_TEMPLATE_TOKENS_PER_REQUEST = 74;
export const SEARCH_TOOL_DEFINITION_TOKENS = 116;
const TRUNCATION_MARK = '…';
const SHRINK_STEP = 0.9;
const RATE_LIMITED_OR_TOO_LARGE = /rate limit|too large|tokens per minute|\b(429|413)\b/i;
const RATE_LIMITED = /rate limit|\b429\b/i;
const TOO_LARGE = /too large|\b413\b/i;

export const BUSY_MESSAGE = 'The model is at its rate limit right now. Please wait a minute and try again.';

export type Turn = { role: 'user' | 'assistant'; content: string };
export type PromptParts<Result> = {
  instructions: string;
  profile: string;
  memory: string;
  history: Turn[];
  userText: string;
  searchResults: Result[];
};

export const estimateTokens = (text: string): number => countTokens(text);

const tokensOf = (part: unknown): number => estimateTokens(typeof part === 'string' ? part : JSON.stringify(part));

const sumTokens = (parts: unknown[]): number => parts.reduce<number>((sum, part) => sum + tokensOf(part), 0);

export const estimatePromptTokens = <Result>(p: PromptParts<Result>): number =>
  CHAT_TEMPLATE_TOKENS_PER_REQUEST +
  SEARCH_TOOL_DEFINITION_TOKENS +
  sumTokens([p.instructions, p.profile, p.memory, p.userText, ...p.history.map((turn) => turn.content), ...p.searchResults]);

export function takeWithinTokens<Item>(bestFirst: Item[], maxTokens: number): Item[] {
  const kept: Item[] = [];
  let used = 0;
  for (const item of bestFirst) {
    const size = tokensOf(item);
    if (used + size > maxTokens) break;
    kept.push(item);
    used += size;
  }
  return kept;
}

function truncateToTokens(text: string, maxTokens: number): string {
  let chars = Math.max(0, maxTokens) * CHARS_PER_TOKEN;
  while (chars > 0 && estimateTokens(text.slice(0, chars)) > maxTokens) chars = Math.floor(chars * SHRINK_STEP);
  return text.slice(0, chars);
}

function fitTaggedBlock(block: string, maxTokens: number): string {
  if (estimateTokens(block) <= maxTokens) return block;
  const lines = block.split('\n');
  const closingTag = lines.at(-1) ?? '';
  const roomForBody = maxTokens - tokensOf(closingTag) - tokensOf(TRUNCATION_MARK);
  const openingTagAndBody = takeWithinTokens(lines.slice(0, -1), roomForBody);
  const onlyTheOpeningTagFits = openingTagAndBody.length <= 1;
  if (onlyTheOpeningTagFits) return '';
  return [...openingTagAndBody, TRUNCATION_MARK, closingTag].join('\n');
}

function newestTurnsWithin(history: Turn[], maxTokens: number): Turn[] {
  const newestFirst = [...history].reverse();
  const kept = takeWithinTokens(newestFirst, maxTokens);
  const newest = newestFirst[0];
  const newestAloneIsTooLong = newest !== undefined && kept.length === 0;
  if (newestAloneIsTooLong) {
    const roomForContent = maxTokens - tokensOf({ ...newest, content: '' });
    return [{ ...newest, content: truncateToTokens(newest.content, roomForContent) }];
  }
  return kept.reverse();
}

export function fitPromptToBudget<Result>(parts: PromptParts<Result>): PromptParts<Result> {
  const fitted = {
    ...parts,
    profile: fitTaggedBlock(parts.profile, TOKEN_BUDGET.instructionsAndProfile - estimateTokens(parts.instructions)),
    memory: fitTaggedBlock(parts.memory, TOKEN_BUDGET.memory),
    searchResults: takeWithinTokens(parts.searchResults, TOKEN_BUDGET.searchResults),
    history: newestTurnsWithin(parts.history, TOKEN_BUDGET.history),
  };
  const overBudget = () => estimatePromptTokens(fitted) > TOKEN_BUDGET.total;
  while (overBudget() && fitted.searchResults.length) fitted.searchResults = fitted.searchResults.slice(0, -1);
  while (overBudget() && fitted.history.length) fitted.history = fitted.history.slice(1);
  return fitted;
}

export function logPromptSize(
  modelCall: string,
  promptParts: unknown[],
  fixedOverhead: number = CHAT_TEMPLATE_TOKENS_PER_REQUEST,
): number {
  const estimated = fixedOverhead + sumTokens(promptParts);
  console.info(`[prompt] ${modelCall}: ~${estimated} tokens`);
  return estimated;
}

export function logActualUsage(modelCall: string, estimated: number, countedByGroq: number | undefined): void {
  if (countedByGroq === undefined) return;
  const difference = Math.round(((countedByGroq - estimated) / countedByGroq) * 100);
  console.info(`[usage] ${modelCall}: estimated ${estimated}, Groq counted ${countedByGroq} (${difference}% off)`);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  return JSON.stringify(error);
}

export function isRateLimited(error: unknown): boolean {
  const raw = errorMessage(error);
  return RATE_LIMITED.test(raw) && !TOO_LARGE.test(raw);
}

export function userFacingError(error: unknown): string {
  const raw = errorMessage(error);
  return RATE_LIMITED_OR_TOO_LARGE.test(raw) ? BUSY_MESSAGE : raw;
}
