import { formatMemory, formatProfile } from '../memory/format';
import { recall, recallTerms, type MemoryClaim, type MemoryItem } from '../memory/recall';
import { listUserFacts } from '../memory/store';
import { planVendorChecks, type VendorCheck } from '../search/reverify-search';
import { refersToPast, resolveTime, type TimeRange } from '../time/resolve';
import { estimatePromptTokens, fitPromptToBudget, TOKEN_BUDGET, type PromptParts, type Turn } from './budget';
import { buildInstructions, verdictSince } from './prompt';
import { route, type Mode } from './router';

export type TurnInput = { conversationId: string; text: string; at: Date; zone: string; history: Turn[] };
export type TurnPlan = {
  mode: Mode;
  reverify: boolean;
  searchesTheWeb: boolean;
  claims: MemoryClaim[];
  verdictSince?: string;
  vendorChecks: VendorCheck[];
  plannedQueries: string[];
  prompt: PromptParts<never>;
  tokensLeftForSearch: number;
};

const claimsIn = (items: MemoryItem[]) => items.flatMap((item) => item.claims);
const subjectsIn = (items: MemoryItem[]) => [...new Set(claimsIn(items).map((claim) => claim.subject))];

export async function planTurn(turn: TurnInput, status: (text: string) => void): Promise<TurnPlan> {
  const { conversationId, text, at, zone, history } = turn;
  const ranges = resolveTime(text, at, zone);
  const datedByRule = refersToPast(ranges, at);
  const previousQuestion = history.findLast((m) => m.role === 'user')?.content ?? '';
  const recallWithin = (within: TimeRange[]) =>
    recall({
      ranges: within,
      topicTerms: recallTerms(text, previousQuestion, within.length > 0),
      now: at,
      excludeConversationId: conversationId,
    });
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

  const vendorChecks = reverify ? planVendorChecks(claimsIn(items)) : [];
  const plannedQueries = searchesTheWeb && !vendorChecks.length ? routed.queries : [];
  const searchedAlready = vendorChecks.length > 0 || plannedQueries.length > 0;

  const since = reverify
    ? verdictSince(
        claimsIn(items).map((claim) => claim.checked_at),
        rangesWhenAboutPast.map((range) => range.start),
        zone,
      )
    : undefined;
  const prompt = fitPromptToBudget({
    instructions: buildInstructions({
      mode,
      now: at,
      tz: zone,
      searchedAlready,
      verdictSince: since,
    }),
    profile: formatProfile(listUserFacts(at), zone),
    memory,
    history,
    userText: text,
    searchResults: [],
  });
  const tokensLeftForSearch = Math.min(TOKEN_BUDGET.searchResults, TOKEN_BUDGET.total - estimatePromptTokens(prompt));
  return {
    mode,
    reverify,
    searchesTheWeb,
    claims: claimsIn(items),
    verdictSince: since,
    vendorChecks,
    plannedQueries,
    prompt,
    tokensLeftForSearch,
  };
}
