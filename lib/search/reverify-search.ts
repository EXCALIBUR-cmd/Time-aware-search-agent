import { classifySource, officialDomainFor } from './official';
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
const THIRD_PARTY_RESULTS_PER_VENDOR = 2;
const PRICING_PAGE_PASSAGE_CHARS = 1200;

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

const labelled = (results: SearchResult[], check: VendorCheck, sourceType: SearchResult['sourceType'], chars?: number) =>
  results.map((result) => ({
    ...result,
    sourceType,
    content: bestPassage(result.content, `${check.vendor} ${check.attributes.join(' ')}`, chars),
  }));

async function officialEvidence(check: VendorCheck, sources: EvidenceSources): Promise<SearchResult[]> {
  if (!check.domain) {
    const found = await sources.search(`${check.vendor} official pricing`);
    return found.filter((result) => classifySource(result.url, check.vendor) === 'official');
  }
  const found = (await sources.search(`${check.vendor} pricing`, [check.domain])).slice(0, OFFICIAL_RESULTS_PER_VENDOR);
  if (found.some((result) => mentionsPrice(result.content))) return found;
  const pricingPage = check.officialUrl ?? found[0]?.url ?? `https://${check.domain}/pricing`;
  const page = await sources.extract(pricingPage).catch(() => undefined);
  if (!page) return found;
  const fromPage = { title: `${check.vendor} pricing page`, url: pricingPage, content: page };
  return [fromPage, ...found.filter((result) => result.url !== pricingPage)];
}

async function evidenceFor(check: VendorCheck, sources: EvidenceSources) {
  const official = await officialEvidence(check, sources).catch(() => []);
  const answeredOfficially = official.some((result) => mentionsPrice(result.content));
  if (answeredOfficially) return { official: labelled(official, check, 'official', PRICING_PAGE_PASSAGE_CHARS), thirdParty: [] };
  const elsewhere = await sources.search(`${check.vendor} ${check.attributes[0] ?? 'pricing'}`).catch(() => []);
  const thirdParty = elsewhere
    .filter((result) => classifySource(result.url, check.vendor) === 'third_party')
    .slice(0, THIRD_PARTY_RESULTS_PER_VENDOR);
  return {
    official: labelled(official, check, 'official', PRICING_PAGE_PASSAGE_CHARS),
    thirdParty: labelled(thirdParty, check, 'third_party'),
  };
}

export async function findEvidence(checks: VendorCheck[], sources: EvidenceSources): Promise<SearchResult[]> {
  const perVendor = await Promise.all(checks.map((check) => evidenceFor(check, sources)));
  const officialFirst = [...perVendor.flatMap((v) => v.official), ...perVendor.flatMap((v) => v.thirdParty)];
  const seen = new Set<string>();
  return officialFirst.filter((result) => !seen.has(result.url) && seen.add(result.url));
}
