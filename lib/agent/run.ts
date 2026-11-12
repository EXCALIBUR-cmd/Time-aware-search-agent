import { groq } from '@ai-sdk/groq';
import { createUIMessageStream, stepCountIs, streamText, type ToolSet } from 'ai';
import { getConfig, now, tz } from '../config';
import { extractClaims, extractUserFacts, mentionsSelf } from '../memory/extract';
import { formatMemory, formatProfile } from '../memory/format';
import { recall, topicTerms } from '../memory/recall';
import { getMessages, listUserFacts, saveClaims, saveMessage, saveUserFacts } from '../memory/store';
import { createWebSearchTool, type NumberedResult } from '../search/web-search-tool';
import { refersToPast, resolveTime } from '../time/resolve';
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

const MAX_TOOL_STEPS = 3;
const HISTORY_TURNS = 12;
const RETRIES_AFTER_GROQ_WAIT = 1;
const logFailure = (what: string) => (e: unknown) => console.error(`${what} failed:`, errorMessage(e));
const logRawErrorAndDescribeForUser = (e: unknown) => {
  console.error('[agent] turn failed:', errorMessage(e));
  return userFacingError(e);
};

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
      let mode = await route(text, refersToPast(ranges, at));
      const aboutPast = mode === 'recall' || mode === 'reverify';
      if (aboutPast) {
        status(`Checking memory${ranges.length ? ` for ${[...new Set(ranges.map((r) => r.phrase))].join(', ')}` : ''}…`);
      }
      const rangesWhenAboutPast = aboutPast ? ranges : [];
      const ownTerms = topicTerms(text);
      const previousQuestion = history.findLast((m) => m.role === 'user')?.content ?? '';
      const terms = ownTerms.length ? ownTerms : topicTerms(previousQuestion);
      const items = recall({ ranges: rangesWhenAboutPast, topicTerms: terms, now: at, excludeConversationId: conversationId });
      const memory = items.length || aboutPast ? formatMemory(items, rangesWhenAboutPast, zone) : '';
      const claimCount = items.reduce((sum, m) => sum + m.claims.length, 0);
      const nothingToReverify = mode === 'reverify' && !items.length;
      if (nothingToReverify) mode = 'recall';
      const reverify = mode === 'reverify';

      const prompt = fitPromptToBudget({
        instructions: buildInstructions({ mode, now: at, tz: zone }),
        profile: formatProfile(listUserFacts(at), zone),
        memory,
        history,
        userText: text,
        searchResults: [],
      });
      const system = [prompt.instructions, prompt.profile, prompt.memory].filter(Boolean).join('\n\n');
      const tokensLeftForSearch = Math.min(TOKEN_BUDGET.searchResults, TOKEN_BUDGET.total - estimatePromptTokens(prompt));

      const sources: NumberedResult[] = [];
      const tools: ToolSet =
        mode === 'fresh' || reverify
          ? {
              web_search: createWebSearchTool({
                bypassCache: reverify,
                tokenBudgetForTurn: tokensLeftForSearch,
                onStatus: status,
                onResult: (r) => {
                  sources.push(r);
                  writer.write({ type: 'source-url', sourceId: String(r.n), url: r.url, title: r.title });
                },
              }),
            }
          : {};

      const result = streamText({
        model: groq(cfg.MAIN_MODEL),
        system,
        messages: [...prompt.history, { role: 'user', content: text }],
        tools,
        maxRetries: RETRIES_AFTER_GROQ_WAIT,
        stopWhen: stepCountIs(MAX_TOOL_STEPS + 1),
        prepareStep: ({ stepNumber, messages }) => {
          logPromptSize(`${cfg.MAIN_MODEL} answer, step ${stepNumber + 1}`, system, messages);
          return stepNumber >= MAX_TOOL_STEPS ? { toolChoice: 'none' as const } : {};
        },
        onError: ({ error }) => console.error('[agent] model call failed:', errorMessage(error)),
        onStepFinish: (step) => {
          if (reverify && step.toolCalls.length) status(`Comparing ${claimCount} claims…`);
        },
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
