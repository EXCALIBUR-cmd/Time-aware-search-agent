import { wordsOf } from '../search/official';
import type { MemoryClaim, MemoryItem } from './recall';

const WORDS_THAT_DO_NOT_NAME_A_CLAIM = new Set([
  'the', 'and', 'for', 'per', 'plan', 'plans', 'tier', 'price', 'pricing', 'cost', 'costs', 'fee', 'monthly', 'limit', 'limits',
  'hour', 'hours', 'month', 'months', 'year', 'gb', 'tb', 'mb',
]);
const SAME_MEANING: Record<string, string> = { db: 'database' };

export const sameClaimKey = (claim: Pick<MemoryClaim, 'subject' | 'attribute'>) =>
  [
    ...new Set(
      wordsOf(`${claim.subject} ${claim.attribute}`)
        .map((word) => SAME_MEANING[word] ?? word)
        .filter((word) => word.length > 2 && !WORDS_THAT_DO_NOT_NAME_A_CLAIM.has(word)),
    ),
  ]
    .sort()
    .join(' ');

function newestUnderShortestName(claims: MemoryClaim[]): Map<string, MemoryClaim> {
  const merged = new Map<string, MemoryClaim>();
  for (const claim of claims) {
    const key = sameClaimKey(claim);
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, claim);
      continue;
    }
    const newest = claim.checked_at > seen.checked_at ? claim : seen;
    const shortestName = claim.subject.length < seen.subject.length ? claim : seen;
    merged.set(key, { ...newest, subject: shortestName.subject, attribute: shortestName.attribute });
  }
  return merged;
}

export const mergeSameClaims = (claims: MemoryClaim[]): MemoryClaim[] => [...newestUnderShortestName(claims).values()];

export function keepOnlyNewestClaims(items: MemoryItem[]): MemoryItem[] {
  const winners = newestUnderShortestName(items.flatMap((item) => item.claims));
  const placed = new Set<string>();
  return items.map((item) => ({
    ...item,
    claims: item.claims.flatMap((claim) => {
      const key = sameClaimKey(claim);
      const winner = winners.get(key);
      const isTheNewest = winner && claim.checked_at === winner.checked_at && claim.value === winner.value;
      if (!winner || !isTheNewest || placed.has(key)) return [];
      placed.add(key);
      return [winner];
    }),
  }));
}
