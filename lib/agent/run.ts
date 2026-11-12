import { groq } from '@ai-sdk/groq';
import { createUIMessageStream, stepCountIs, streamText, type ToolSet } from 'ai';
import { getConfig, now, tz } from '../config';
import { extractClaims, extractUserFacts, mentionsSelf } from '../memory/extract';
import { formatMemory, formatProfile } from '../memory/format';
import { recall, topicTerms, type MemoryItem } from '../memory/recall';
import { getMessages, listUserFacts, saveClaims, saveMessage, saveUserFacts } from '../memory/store';
import { createSearchSession, formatSearchResults, type NumberedResult } from '../search/web-search-tool';
import { refersToPast, resolveTime, type TimeRange } from '../time/resolve';
import {
  errorMessage,
  estimatePromptTokens,
  fitPromptToBudget,
  logPromptSize,
  TOKEN_BUDGET,
  userFacingError,
} from './budget';
import { buildInstructions } from './prompt';
import { route } from './router';

const FOLLOW_UP_SEARCHES = 1;
const MAX_QUERIES_PER_SEARCH = 4;
const HISTORY_TURNS = 12;
const RETRIES_AFTER_GROQ_WAIT = 1;
const ANSWER_WITHOUT_SEARCHING_AGAIN =
  'You have no searches left this turn. Answer now from the results you already have; do not call any tool.';
const logFailure = (what: string) => (e: unknown) => console.error(`${what} failed:`, errorMessage(e));
const logRawErrorAndDescribeForUser = (e: unknown) => {
  console.error('[agent] turn failed:', errorMessage(e));
  return userFacingError(e);
};

const claimsIn = (items: MemoryItem[]) => items.flatMap((item) => item.claims);
const subjectsIn = (items: MemoryItem[]) => [...new Set(claimsIn(items).map((claim) => claim.subject))];

function oneQueryPerClaimSubject(items: MemoryItem[]): string[] {
  const queryBySubject = new Map<string, string>();
  for (const claim of claimsIn(items)) {
    if (!queryBySubject.has(claim.subject)) queryBySubject.set(claim.subject, `${claim.subject} ${claim.attribute}`);
  }
  return [...queryBySubject.values()].slice(0, MAX_QUERIES_PER_SEARCH);
}

export function runAgent({
  conversationId,
  text,
  simulatedNow,
}: {
  conversationId: string;
  text: string;
  simulatedNow?: Date;
}) {
  const cfg = getConfig();
  const clock = () => simulatedNow ?? now();
  const at = clock();
  const zone = tz();
  const history = getMessages(conversationId)
    .slice(-HISTORY_TURNS)
    .map(({ role, content }) => ({ role, content }));
  const userMessageId = saveMessage({ conversationId, role: 'user', content: text, at });

  return createUIMessageStream({
    onError: logRawErrorAndDescribeForUser,
    execute: async ({ writer }) => {
      const status = (s: string) => writer.write({ type: 'data-status', data: s, transient: true });
      status('Thinking…');

      const ranges = resolveTime(text, at, zone);
      const datedByRule = refersToPast(ranges, at);
      const ownTerms = topicTerms(text);
      const previousQuestion = history.findLast((m) => m.role === 'user')?.content ?? '';
      const terms = ownTerms.length ? ownTerms : topicTerms(previousQuestion);
      const recallWithin = (within: TimeRange[]) =>
        recall({ ranges: within, topicTerms: terms, now: at, excludeConversationId: conversationId });
      const firstLook = recallWithin(datedByRule ? ranges : []);

      const routed = await route(text, datedByRule, { previousQuestion, subjectsInMemory: subjectsIn(firstLook) });
      let mode = routed.mode;
      const aboutPast = mode === 'recall' || mode === 'reverify';
      if (aboutPast) {
        status(`Checking memory${ranges.length ? ` for ${[...new Set(ranges.map((r) => r.phrase))].join(', ')}` : ''}…`);
      }
      const rangesWhenAboutPast = aboutPast ? ranges : [];
      const routerFoundAPastTheRuleMissed = aboutPast && !datedByRule && ranges.length > 0;
      const items = routerFoundAPastTheRuleMissed ? recallWithin(ranges) : firstLook;
      const memory = items.length || aboutPast ? formatMemory(items, rangesWhenAboutPast, zone) : '';
      const nothingToReverify = mode === 'reverify' && !items.length;
      if (nothingToReverify) mode = 'recall';
      const reverify = mode === 'reverify';
      const searchesTheWeb = mode === 'fresh' || reverify;

      const queriesFromClaims = reverify ? oneQueryPerClaimSubject(items) : [];
      const plannedQueries = !searchesTheWeb ? [] : routed.queries.length ? routed.queries : queriesFromClaims;
      const searchedAlready = plannedQueries.length > 0;

      const prompt = fitPromptToBudget({
        instructions: buildInstructions({ mode, now: at, tz: zone, searchedAlready }),
        profile: formatProfile(listUserFacts(at), zone),
        memory,
        history,
        userText: text,
        searchResults: [],
      });
      const tokensLeftForSearch = Math.min(TOKEN_BUDGET.searchResults, TOKEN_BUDGET.total - estimatePromptTokens(prompt));

      const sources: NumberedResult[] = [];
      const session = createSearchSession({
        bypassCache: reverify,
        tokenBudgetForTurn: tokensLeftForSearch,
        onStatus: status,
        onResult: (r) => {
          sources.push(r);
          writer.write({ type: 'source-url', sourceId: String(r.n), url: r.url, title: r.title });
        },
      });
      const searched = searchedAlready ? await session.search(plannedQueries) : undefined;
      if (searched && reverify) status(`Comparing ${claimsIn(items).length} claims…`);

      const system = [prompt.instructions, prompt.profile, prompt.memory, searched ? formatSearchResults(searched) : '']
        .filter(Boolean)
        .join('\n\n');
      const tools: ToolSet = searchesTheWeb ? { web_search: session.followUpTool } : {};

      const result = streamText({
        model: groq(cfg.MAIN_MODEL),
        system,
        messages: [...prompt.history, { role: 'user', content: text }],
        tools,
        maxRetries: RETRIES_AFTER_GROQ_WAIT,
        stopWhen: stepCountIs(FOLLOW_UP_SEARCHES + 1),
        prepareStep: ({ stepNumber, messages }) => {
          const outOfSearches = stepNumber >= FOLLOW_UP_SEARCHES;
          const stepSystem = outOfSearches ? `${system}\n\n${ANSWER_WITHOUT_SEARCHING_AGAIN}` : system;
          logPromptSize(`${cfg.MAIN_MODEL} answer, step ${stepNumber + 1}`, stepSystem, messages);
          return outOfSearches ? { toolChoice: 'none' as const, system: stepSystem } : {};
        },
        onError: ({ error }) => console.error('[agent] model call failed:', errorMessage(error)),
        onFinish: ({ steps }) => {
          if (mentionsSelf(text)) {
            void extractUserFacts(text)
              .then((facts) => saveUserFacts(facts, userMessageId, at))
              .catch(logFailure('user fact extraction'));
          }
          const answer = steps.map((s) => s.text).join('').trim();
          if (!answer) return;
          const id = saveMessage({ conversationId, role: 'assistant', content: answer, at: clock() });
          if (sources.length) {
            void extractClaims(answer, sources)
              .then((claims) => saveClaims(id, claims, clock()))
              .catch(logFailure('claim extraction'));
          }
        },
      });
      writer.merge(result.toUIMessageStream({ onError: userFacingError, sendReasoning: false }));
    },
  });
}
