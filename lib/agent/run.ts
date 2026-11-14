import { createUIMessageStream, type ModelMessage } from 'ai';
import { citedNumbers } from '../citations';
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
import { answerWithFallback } from './fallback';
import { planTurn } from './plan';
import { claimsToCompare } from './reverify';
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
          writer.write({ type: 'source-url', sourceId: String(r.n), url: r.url, title: r.title });
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
      const onAnswerFinished = (answerText: string, modelId: string, checkedClaims?: Claim[]) => {
        if (mentionsSelf(text)) {
          void extractUserFacts(text)
            .then((facts) => saveUserFacts(facts, userMessageId, at))
            .catch(logFailure('user fact extraction'));
        }
        if (!answerText) return;
        const id = saveMessage({ conversationId, role: 'assistant', content: answerText, at: clock(), answeredByModel: modelId });
        if (checkedClaims) {
          saveClaims(id, checkedClaims, clock());
          return;
        }
        const cited = citedNumbers(answerText);
        const citedSources = sources.filter((source) => cited.has(String(source.n)));
        if (citedSources.length) {
          void extractClaims(answerText, citedSources)
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
        const confirmed = checked.rows.flatMap((row) =>
          row.now && row.source
            ? [{ subject: row.subject, attribute: row.attribute, value: row.now, sourceUrl: row.source.url, sourceType: row.source.sourceType }]
            : [],
        );
        onAnswerFinished(checked.markdown, checked.modelId, confirmed);
        return;
      }

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
    },
  });
}
