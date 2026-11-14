import type { SourceType } from './tavily';

const MIN_VENDOR_LABEL_CHARS = 4;
const MIN_SHORT_VENDOR_LABEL_CHARS = 3;
const GENERIC_HOST_LABELS = new Set(['www', 'docs', 'blog', 'help', 'support', 'news', 'pricing', 'community', 'forum']);
const OFFICIAL_DOMAINS: Record<string, string> = {
  neon: 'neon.com',
  supabase: 'supabase.com',
  railway: 'railway.com',
};

export const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export function isVendorDomainFor(url: string, query: string): boolean {
  const queryWords = wordsOf(query);
  const queryWithoutSeparators = queryWords.join('');
  const labels = (hostOf(url) ?? '').split('.').slice(0, -1);
  const namesTheVendor = (label: string) =>
    (label.length >= MIN_VENDOR_LABEL_CHARS && queryWithoutSeparators.includes(label)) ||
    (label.length >= MIN_SHORT_VENDOR_LABEL_CHARS && queryWords.includes(label));
  return labels.some((label) => !GENERIC_HOST_LABELS.has(label) && namesTheVendor(label));
}

const knownDomainFor = (subject: string) => wordsOf(subject).map((word) => OFFICIAL_DOMAINS[word]).find(Boolean);

const isOnDomain = (url: string, domain: string) => {
  const host = hostOf(url);
  return host !== undefined && (host === domain || host.endsWith(`.${domain}`));
};

export function classifySource(url: string, subject: string): SourceType {
  const domain = knownDomainFor(subject);
  const official = domain ? isOnDomain(url, domain) : isVendorDomainFor(url, subject);
  return official ? 'official' : 'third_party';
}

const withoutGenericSubdomain = (host: string) => {
  const [first, ...rest] = host.split('.');
  return rest.length > 1 && GENERIC_HOST_LABELS.has(first) ? rest.join('.') : host;
};

export function officialDomainFor(subject: string, knownSourceUrl?: string | null): string | undefined {
  const known = knownDomainFor(subject);
  if (known) return known;
  const sourceIsOfficial = knownSourceUrl && classifySource(knownSourceUrl, subject) === 'official';
  const host = sourceIsOfficial ? hostOf(knownSourceUrl) : undefined;
  return host ? withoutGenericSubdomain(host) : undefined;
}
