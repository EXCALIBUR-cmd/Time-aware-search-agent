import { groq } from '@ai-sdk/groq';
import { createUIMessageStream, stepCountIs, streamText, type ToolSet } from 'ai';
import { getConfig, now, tz } from '../config';
import { extractClaims, extractUserFacts, mentionsSelf } from '../memory/extract';
import { formatMemory, formatProfile } from '../memory/format';
import { recall, topicTerms } from '../memory/recall';
import { getMessages, listUserFacts, saveClaims, saveMessage, saveUserFacts } from '../memory/store';
import { createWebSearchTool, type NumberedResult } from '../search/web-search-tool';
import { refersToPast, resolveTime } from '../time/resolve';
import { buildSystemPrompt } from './prompt';
import { route } from './router';

const MAX_TOOL_STEPS = 3;
const HISTORY_TURNS = 12;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const logFailure = (what: string) => (e: unknown) => console.error(`${what} failed:`, errorText(e));

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
    onError: errorText,
    execute: async ({ writer }) => {
      const status = (s: string) => writer.write({ type: 'data-status', data: s, transient: true });
      status('Thinking…');

      const ranges = resolveTime(text, at, zone);
      let mode = await route(text, refersToPast(ranges, at));
      const aboutPast = mode === 'recall' || mode === 'reverify';
      if (aboutPast) {
        status(`Checking memory${ranges.length ? ` for ${[...new Set(ranges.map((r) => r.phrase))].join(', ')}` : ''}…`);
      }
      const dateRanges = aboutPast ? ranges : [];
      const ownTerms = topicTerms(text);
      const terms = ownTerms.length ? ownTerms : topicTerms(history.findLast((m) => m.role === 'user')?.content ?? '');
      const items = recall({ ranges: dateRanges, topicTerms: terms, now: at, excludeConversationId: conversationId });
      const memory = items.length || aboutPast ? formatMemory(items, dateRanges, zone) : '';
      const claimCount = items.reduce((sum, m) => sum + m.claims.length, 0);
      if (mode === 'reverify' && !items.length) mode = 'recall';
      const reverify = mode === 'reverify';

      const sources: NumberedResult[] = [];
      const tools: ToolSet =
        mode === 'fresh' || reverify
          ? {
              web_search: createWebSearchTool({
                bypassCache: reverify,
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
        system: buildSystemPrompt({ mode, profile: formatProfile(listUserFacts(at), zone), memory, now: at, tz: zone }),
        messages: [...history, { role: 'user', content: text }],
        tools,
        stopWhen: stepCountIs(MAX_TOOL_STEPS + 1),
        prepareStep: ({ stepNumber }) => (stepNumber >= MAX_TOOL_STEPS ? { toolChoice: 'none' } : {}),
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
      writer.merge(result.toUIMessageStream({ onError: errorText, sendReasoning: false }));
    },
  });
}
