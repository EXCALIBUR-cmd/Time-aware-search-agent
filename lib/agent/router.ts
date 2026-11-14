import { groq } from '@ai-sdk/groq';
import { generateText } from 'ai';
import { z } from 'zod';
import { FAST_MODEL_PROVIDER_OPTIONS, getConfig } from '../config';
import { logActualUsage, logPromptSize } from './budget';

export type Mode = 'chat' | 'fresh' | 'recall' | 'reverify';
export type RoutingPlan = { mode: Mode; queries: string[] };
export type RoutingContext = { previousQuestion: string; subjectsInMemory: string[] };

const MAX_PLANNED_QUERIES = 4;
const PREVIOUS_QUESTION_CHARS = 300;
const ROUTER_TIMEOUT_MS = 2000;
const PLAN_WHEN_ROUTER_FAILS: RoutingPlan = { mode: 'fresh', queries: [] };

const Plan = z.object({
  mode: z.enum(['chat', 'fresh', 'recall', 'reverify']),
  queries: z.array(z.string()).default([]),
});

const SYSTEM = `Classify the user's message for a chat agent and plan its web searches. Reply with JSON only: {"mode":"fresh","queries":["..."]}
mode is one of:
chat: greetings, thanks, small talk, questions about the assistant.
fresh: needs current information from the web, or follows up on the current chat ("which of those is cheapest?").
recall: asks what was said, asked or discussed in a past conversation, without asking whether it is still true.
reverify: only when the message asks whether something from a past conversation has changed or is still correct.
"Subjects in memory" is background, never a reason on its own to choose reverify.
queries: for fresh and reverify, 1 to 4 short web search queries. Use exactly one query for a single question; use more only when the message names several products or topics, one query per item. For reverify write one query per subject listed under "Subjects in memory", for example "Neon Postgres pricing". For chat and recall, and for a follow-up the previous answer already covers, use [].`;

const MEMORY_PHRASE =
  /\b(remember|did i (tell|say|ask|mention)|what did (i|we) (tell|say|ask|talk|discuss)|i (told|said|mentioned)|we (talked|discussed))\b/i;
const ASKS_WHAT_CHANGED = /\b(still|chang\w*|since|updat\w*|shipped)\b/i;
const RECHECK_WORDS = new RegExp(`${ASKS_WHAT_CHANGED.source}|\\bnow\\b`, 'i');

export function applyOverrides(mode: Mode, text: string, hasPastDate: boolean, hasClaimsInMemory = false): Mode {
  const asksWhetherStillTrue = RECHECK_WORDS.test(text);
  const asksAboutThePast = MEMORY_PHRASE.test(text);
  if (hasPastDate) return asksWhetherStillTrue ? 'reverify' : 'recall';
  const reverifyWithoutBeingAsked = mode === 'reverify' && !asksWhetherStillTrue;
  if (reverifyWithoutBeingAsked) return asksAboutThePast ? 'recall' : 'fresh';
  if (mode === 'reverify') return mode;
  const asksWhatChangedInRememberedClaims = hasClaimsInMemory && ASKS_WHAT_CHANGED.test(text);
  if (asksWhatChangedInRememberedClaims) return 'reverify';
  return asksAboutThePast ? 'recall' : mode;
}

export function parsePlan(modelOutput: string): RoutingPlan {
  const plan = Plan.parse(JSON.parse(modelOutput.match(/\{[\s\S]*\}/)?.[0] ?? ''));
  const queries = plan.queries
    .map((query) => query.trim())
    .filter(Boolean)
    .slice(0, MAX_PLANNED_QUERIES);
  return { mode: plan.mode, queries };
}

const describeTurn = (text: string, context: RoutingContext) =>
  [
    `Message: ${text}`,
    context.previousQuestion ? `Previous question: ${context.previousQuestion.slice(0, PREVIOUS_QUESTION_CHARS)}` : '',
    context.subjectsInMemory.length ? `Subjects in memory: ${context.subjectsInMemory.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

async function askModelForPlan(text: string, context: RoutingContext): Promise<RoutingPlan> {
  const prompt = describeTurn(text, context);
  const estimated = logPromptSize('router', [SYSTEM, prompt]);
  const { text: out, usage } = await generateText({
    model: groq(getConfig().FAST_MODEL),
    providerOptions: FAST_MODEL_PROVIDER_OPTIONS,
    system: SYSTEM,
    prompt,
    temperature: 0,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
  });
  logActualUsage('router', estimated, usage.inputTokens);
  return parsePlan(out);
}

export async function route(text: string, hasPastDate: boolean, context: RoutingContext): Promise<RoutingPlan> {
  const planned = await askModelForPlan(text, context).catch(() => PLAN_WHEN_ROUTER_FAILS);
  const mode = applyOverrides(planned.mode, text, hasPastDate, context.subjectsInMemory.length > 0);
  const searchesTheWeb = mode === 'fresh' || mode === 'reverify';
  return { mode, queries: searchesTheWeb ? planned.queries : [] };
}
