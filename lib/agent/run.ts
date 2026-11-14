import { createUIMessageStream, type ModelMessage } from 'ai';
import { citedNumbers, citedSources } from '../citations';
import { FAST_MODEL_PROVIDER_OPTIONS, getConfig, now, tz } from '../config';
import { extractClaims, extractUserFacts, mentionsSelf } from '../memory/extract';
import { getMessages, saveClaims, saveMessage, saveUserFacts, type Claim } from '../memory/store';
import { findEvidence } from '../search/reverify-search';
import {
  createSearchSession,
  formatSearchResults,
  liveEvidenceSources,
  type NumberedResult,
} from '../search/web-search-tool';
import { ANSWER_WITHOUT_SEARCHING_AGAIN, joinSections, NO_TOOLS, streamAnswer, type AnswerRequest } from './answer';
import { errorMessage, userFacingError } from './budget';
import { requireInlineCitations } from './cite';
import { answerWithFallback } from './fallback';
import { planTurn } from './plan';
import { claimsToCompare, claimsToSave } from './reverify';
import { answerReverification } from './reverify-answer';

const HISTORY_TURNS = 12;
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
      const plan = await planTurn({ conversationId, text, at, zone, history }, status);

      const sources: NumberedResult[] = [];
      const session = createSearchSession({
        bypassCache: plan.reverify,
        tokenBudgetForTurn: plan.tokensLeftForSearch,
        onStatus: status,
        onResult: (r) => {
          sources.push(r);
          writer.write({
            type: 'source-url',
            sourceId: String(r.n),
            url: r.url,
            title: r.title,
            ...(r.sourceType ? { providerMetadata: { agent: { sourceType: r.sourceType } } } : {}),
          });
        },
      });
      const checkOfficialPagesFirst = async () => {
        status(`Checking official pages: ${plan.vendorChecks.map((check) => check.domain ?? check.vendor).join(', ')}…`);
        return session.present(await findEvidence(plan.vendorChecks, liveEvidenceSources(true)));
      };
      const searched = plan.vendorChecks.length
        ? await checkOfficialPagesFirst()
        : plan.plannedQueries.length
          ? await session.search(plan.plannedQueries)
          : undefined;

      const messages: ModelMessage[] = [...plan.prompt.history, { role: 'user', content: text }];
      const promptWithoutResults = [plan.prompt.instructions, plan.prompt.profile, plan.prompt.memory];
      const extractFactsAboutTheUser = () => {
        if (!mentionsSelf(text)) return;
        void extractUserFacts(text)
          .then((facts) => saveUserFacts(facts, userMessageId, at))
          .catch(logFailure('user fact extraction'));
      };
      const saveAnswer = (answerText: string, modelId: string, checkedClaims?: Claim[]) => {
        const chips = citedSources(
          answerText,
          sources.map((s) => ({ sourceId: String(s.n), title: s.title, url: s.url, official: s.sourceType === 'official' })),
        );
        const id = saveMessage({
          conversationId,
          role: 'assistant',
          content: answerText,
          at: clock(),
          answeredByModel: modelId,
          sources: chips,
        });
        if (checkedClaims) {
          saveClaims(id, checkedClaims, clock());
          return;
        }
        const cited = citedNumbers(answerText);
        const citedResults = sources.filter((source) => cited.has(String(source.n)));
        if (citedResults.length) {
          void extractClaims(answerText, citedResults)
            .then((claims) => saveClaims(id, claims, clock()))
            .catch(logFailure('claim extraction'));
        }
      };
      if (plan.vendorChecks.length && searched && plan.verdictSince) {
        const checked = await answerReverification(
          {
            rows: claimsToCompare(plan.claims),
            sources,
            since: plan.verdictSince,
            tz: zone,
            models: { main: cfg.MAIN_MODEL, fast: cfg.FAST_MODEL },
          },
          writer,
          status,
        );
        extractFactsAboutTheUser();
        saveAnswer(checked.markdown, checked.modelId, claimsToSave(checked.rows));
        return;
      }

      let finished: { answerText: string; modelId: string } | undefined;
      const onAnswerFinished = (answerText: string, modelId: string) => {
        extractFactsAboutTheUser();
        if (answerText) finished = { answerText, modelId };
      };
      const answer = (request: AnswerRequest) => streamAnswer(request, messages, onAnswerFinished);
      const withoutTools = (modelId: string, providerOptions?: typeof FAST_MODEL_PROVIDER_OPTIONS) => {
        const everythingFoundThisTurn = sources.length
          ? formatSearchResults({ results: sources, errors: [], searched_at: now().toISOString() })
          : '';
        return answer({
          modelId,
          providerOptions,
          system: joinSections([...promptWithoutResults, everythingFoundThisTurn, ANSWER_WITHOUT_SEARCHING_AGAIN]),
          tools: NO_TOOLS,
        });
      };

      await answerWithFallback(
        {
          fromMainModel: () =>
            answer({
              modelId: cfg.MAIN_MODEL,
              system: joinSections([...promptWithoutResults, searched ? formatSearchResults(searched) : '']),
              tools: plan.searchesTheWeb ? { web_search: session.followUpTool } : NO_TOOLS,
            }),
          fromMainModelWithoutTools: () => withoutTools(cfg.MAIN_MODEL),
          fromFastModelWithoutTools: () => withoutTools(cfg.FAST_MODEL, FAST_MODEL_PROVIDER_OPTIONS),
          usedItsFollowUpSearch: () => sources.length > (searched?.results.length ?? 0),
        },
        writer,
        status,
      );
      if (!finished) return;
      const models = { main: finished.modelId, fast: cfg.FAST_MODEL };
      const answerText = await requireInlineCitations(finished.answerText, sources, models, status);
      if (answerText !== finished.answerText) writer.write({ type: 'data-final-answer', data: answerText });
      saveAnswer(answerText, finished.modelId);
    },
  });
}
