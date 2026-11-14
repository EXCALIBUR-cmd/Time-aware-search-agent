import { classifySource, officialDomainFor, wordsOf } from './official';
import type { SearchResult } from './tavily';
import { bestPassage, mentionsPrice } from './web-search-tool';

export type ClaimToCheck = { subject: string; attribute: string; source_url: string | null };
export type VendorCheck = { vendor: string; domain?: string; officialUrl?: string; attributes: string[] };
export type EvidenceSources = {
  search: (query: string, includeDomains?: string[]) => Promise<SearchResult[]>;
  extract: (url: string) => Promise<string | undefined>;
};

const MAX_VENDORS = 4;
const OFFICIAL_RESULTS_PER_VENDOR = 2;
const THIRD_PARTY_SEARCHES_PER_TURN = 2;
const THIRD_PARTY_RESULTS_PER_CLAIM = 2;
const PRICING_PAGE_PASSAGE_CHARS = 1200;
const GENERIC_ATTRIBUTE_WORDS = new Set([
  'the', 'and', 'for', 'per', 'plan', 'plans', 'price', 'pricing', 'cost', 'costs', 'monthly', 'month', 'fee', 'tier', 'limit',
]);

export function planVendorChecks(claims: ClaimToCheck[]): VendorCheck[] {
  const byVendor = new Map<string, VendorCheck>();
  for (const claim of claims) {
    const domain = officialDomainFor(claim.subject, claim.source_url);
    const key = domain ?? claim.subject.toLowerCase();
    const check = byVendor.get(key) ?? { vendor: claim.subject, domain, attributes: [] };
    if (claim.subject.length < check.vendor.length) check.vendor = claim.subject;
    const officialSource = claim.source_url && classifySource(claim.source_url, claim.subject) === 'official';
    if (officialSource && !check.officialUrl) check.officialUrl = claim.source_url ?? undefined;
    if (!check.attributes.includes(claim.attribute)) check.attributes.push(claim.attribute);
    byVendor.set(key, check);
  }
  return [...byVendor.values()].slice(0, MAX_VENDORS);
}

export function isAnsweredBy(attribute: string, results: SearchResult[]): boolean {
  const distinctive = wordsOf(attribute).filter((word) => word.length > 2 && !GENERIC_ATTRIBUTE_WORDS.has(word));
  if (!distinctive.length) return results.some((result) => mentionsPrice(result.content));
  return results.some((result) => {
    const content = result.content.toLowerCase();
    return distinctive.every((word) => content.includes(word));
  });
}

const labelled = (results: SearchResult[], focus: string, sourceType: SearchResult['sourceType'], chars?: number) =>
  results.map((result) => ({ ...result, sourceType, content: bestPassage(result.content, focus, chars) }));

async function officialEvidence(check: VendorCheck, sources: EvidenceSources): Promise<SearchResult[]> {
  if (!check.domain) {
    const found = await sources.search(`${check.vendor} official pricing`);
    return found.filter((result) => classifySource(result.url, check.vendor) === 'official');
  }
  const found = (await sources.search(`${check.vendor} pricing`, [check.domain])).slice(0, OFFICIAL_RESULTS_PER_VENDOR);
  const everyClaimAnswered = check.attributes.every((attribute) => isAnsweredBy(attribute, found));
  if (everyClaimAnswered) return found;
  const pricingPage = check.officialUrl ?? found[0]?.url ?? `https://${check.domain}/pricing`;
  const page = await sources.extract(pricingPage).catch(() => undefined);
  if (!page) return found;
  const fromPage = { title: `${check.vendor} pricing page`, url: pricingPage, content: page };
  return [fromPage, ...found.filter((result) => result.url !== pricingPage)];
}

async function thirdPartyEvidence(check: VendorCheck, attribute: string, sources: EvidenceSources) {
  const found = await sources.search(`${check.vendor} ${attribute}`).catch(() => []);
  const elsewhere = found.filter((result) => classifySource(result.url, check.vendor) === 'third_party');
  return labelled(elsewhere.slice(0, THIRD_PARTY_RESULTS_PER_CLAIM), `${check.vendor} ${attribute}`, 'third_party');
}

export async function findEvidence(checks: VendorCheck[], sources: EvidenceSources): Promise<SearchResult[]> {
  const officialPerVendor = await Promise.all(checks.map((check) => officialEvidence(check, sources).catch(() => [])));
  const unconfirmed = checks
    .flatMap((check, i) =>
      check.attributes.filter((attribute) => !isAnsweredBy(attribute, officialPerVendor[i])).map((attribute) => ({ check, attribute })),
    )
    .slice(0, THIRD_PARTY_SEARCHES_PER_TURN);
  const thirdParty = await Promise.all(unconfirmed.map(({ check, attribute }) => thirdPartyEvidence(check, attribute, sources)));
  const official = officialPerVendor.flatMap((results, i) =>
    labelled(results, `${checks[i].vendor} ${checks[i].attributes.join(' ')}`, 'official', PRICING_PAGE_PASSAGE_CHARS),
  );
  const seen = new Set<string>();
  return [...official, ...thirdParty.flat()].filter((result) => !seen.has(result.url) && seen.add(result.url));
}
