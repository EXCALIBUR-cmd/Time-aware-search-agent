import { expect, test } from 'vitest';
import { classifySource, officialDomainFor } from './official';
import { passagePerClaim } from './passages';
import { findEvidence, isAnsweredBy, pageTypeRank, planVendorChecks, type EvidenceSources } from './reverify-search';
import type { SearchResult } from './tavily';

const PRICED = 'The Launch plan costs $19/month and storage is $0.35 per GB-month.';
const UNPRICED = 'Neon is serverless Postgres that separates storage and compute.';
const result = (url: string, content = PRICED): SearchResult => ({ title: url, url, content });

function fakeSources(answers: Record<string, SearchResult[]>, pages: Record<string, string> = {}) {
  const calls: string[] = [];
  const sources: EvidenceSources = {
    search: async (query, includeDomains) => {
      const key = includeDomains?.length ? `${query} @${includeDomains.join(',')}` : query;
      calls.push(`search ${key}`);
      return answers[key] ?? [];
    },
    extract: async (url) => {
      calls.push(`extract ${url}`);
      return pages[url];
    },
  };
  return { sources, calls };
}

test('a source is official only on the vendor’s own domain', () => {
  expect(classifySource('https://neon.com/docs/introduction/plans', 'Neon')).toBe('official');
  expect(classifySource('https://console.neon.com/pricing', 'Neon')).toBe('official');
  expect(classifySource('https://www.prisma.io/compare/neon', 'Neon')).toBe('third_party');
  expect(classifySource('https://getdeploying.com/railway', 'Railway')).toBe('third_party');
  expect(classifySource('https://render.com/pricing', 'Render Postgres')).toBe('official');
  expect(classifySource('https://fly.io/docs/about/pricing', 'Fly.io Postgres')).toBe('official');
  expect(classifySource('https://www.g2.com/products/fly', 'Fly.io Postgres')).toBe('third_party');
});

test('the official domain comes from an official source URL, else from the map, else nothing', () => {
  expect(officialDomainFor('Render Postgres', 'https://render.com/pricing')).toBe('render.com');
  expect(officialDomainFor('Railway', 'https://getdeploying.com/railway')).toBe('railway.com');
  expect(officialDomainFor('Supabase', null)).toBe('supabase.com');
  expect(officialDomainFor('Fly.io Postgres', 'https://some-blog.example/fly')).toBeUndefined();
  expect(officialDomainFor('Railway', 'https://docs.railway.com/pricing/plans')).toBe('railway.com');
  expect(officialDomainFor('Render Postgres', 'https://docs.render.com/postgresql')).toBe('render.com');
});

test('claims are grouped per vendor, keeping an official URL to extract', () => {
  const checks = planVendorChecks([
    { subject: 'Neon', attribute: 'Launch compute price', source_url: 'https://www.prisma.io/compare/neon' },
    { subject: 'Neon', attribute: 'Launch storage price', source_url: 'https://neon.com/docs/introduction/plans' },
    { subject: 'Neon Launch compute price', attribute: 'price per CU-hour', source_url: 'https://www.srvrlss.io/provider/neon' },
    { subject: 'Railway', attribute: 'Hobby plan monthly cost', source_url: 'https://getdeploying.com/railway' },
    { subject: 'Railway Hobby plan', attribute: 'Postgres storage', source_url: 'https://docs.railway.com/pricing/plans' },
    { subject: 'Fly.io Postgres', attribute: 'Starter price', source_url: null },
  ]);
  expect(checks).toEqual([
    {
      vendor: 'Neon',
      domain: 'neon.com',
      officialUrl: 'https://neon.com/docs/introduction/plans',
      attributes: ['Launch compute price', 'Launch storage price', 'price per CU-hour'],
    },
    {
      vendor: 'Railway',
      domain: 'railway.com',
      officialUrl: 'https://docs.railway.com/pricing/plans',
      attributes: ['Hobby plan monthly cost', 'Postgres storage'],
    },
    { vendor: 'Fly.io Postgres', domain: undefined, attributes: ['Starter price'] },
  ]);
});

test('official results with prices are enough: no page fetch, no third-party search', async () => {
  const { sources, calls } = fakeSources({ 'Neon pricing @neon.com': [result('https://neon.com/pricing')] });
  const evidence = await findEvidence([{ vendor: 'Neon', domain: 'neon.com', attributes: ['Launch price'] }], sources);
  expect(calls).toEqual(['search Neon pricing @neon.com']);
  expect(evidence.map((r) => [r.url, r.sourceType])).toEqual([['https://neon.com/pricing', 'official']]);
});

test('without prices in the snippets, the official pricing page is fetched', async () => {
  const { sources, calls } = fakeSources(
    { 'Neon pricing @neon.com': [result('https://neon.com/blog/postgres', UNPRICED)] },
    { 'https://neon.com/docs/introduction/plans': `${'intro '.repeat(400)} Launch plan: ${PRICED}` },
  );
  const check = { vendor: 'Neon', domain: 'neon.com', officialUrl: 'https://neon.com/docs/introduction/plans', attributes: ['Launch plan'] };
  const evidence = await findEvidence([check], sources);
  expect(calls).toEqual(['search Neon pricing @neon.com', 'extract https://neon.com/docs/introduction/plans']);
  expect(evidence[0]).toMatchObject({ url: 'https://neon.com/docs/introduction/plans', sourceType: 'official' });
  expect(evidence[0].content).toContain('$19/month');
});

test('third-party sites are used only when the official pages give no answer, and are labelled', async () => {
  const { sources, calls } = fakeSources({
    'Railway pricing @railway.com': [result('https://railway.com/about', 'Railway deploys apps.')],
    'Railway Hobby plan monthly cost': [result('https://getdeploying.com/railway'), result('https://railway.com/pricing')],
  });
  const evidence = await findEvidence([{ vendor: 'Railway', domain: 'railway.com', attributes: ['Hobby plan monthly cost'] }], sources);
  expect(calls).toEqual([
    'search Railway pricing @railway.com',
    'extract https://railway.com/about',
    'search Railway Hobby plan monthly cost',
  ]);
  expect(evidence.map((r) => [r.url, r.sourceType])).toEqual([
    ['https://railway.com/about', 'official'],
    ['https://getdeploying.com/railway', 'third_party'],
  ]);
});

test('a vendor with no known domain gets a generic "official pricing" query; official results rank first', async () => {
  const { sources, calls } = fakeSources({
    'Fly.io Postgres official pricing': [result('https://fly.io/docs/about/pricing'), result('https://blog.example/fly')],
    'Neon pricing @neon.com': [result('https://neon.com/pricing')],
  });
  const evidence = await findEvidence(
    [
      { vendor: 'Fly.io Postgres', attributes: ['Starter price'] },
      { vendor: 'Neon', domain: 'neon.com', attributes: ['Launch price'] },
    ],
    sources,
  );
  expect(calls).toContain('search Fly.io Postgres official pricing');
  expect(evidence.map((r) => r.url)).toEqual(['https://fly.io/docs/about/pricing', 'https://neon.com/pricing']);
});

test('a claim counts as answered when a result names what it is about, not just any price', () => {
  const page = [result('https://railway.com/pricing', 'Hobby plan: $5/month with $5 of usage credit.')];
  expect(isAnsweredBy('Hobby plan monthly cost', page)).toBe(true);
  expect(isAnsweredBy('Hobby plan usage credit', page)).toBe(true);
  expect(isAnsweredBy('Hobby plan Postgres storage', page)).toBe(false);
  expect(isAnsweredBy('monthly price', page)).toBe(true);
  expect(isAnsweredBy('monthly price', [result('https://railway.com/about', 'Deploy apps.')])).toBe(false);
});

test('only the claim the official pages leave unanswered gets a third-party search', async () => {
  const railwayPage = 'Hobby plan: $5/month with $5 of usage credit.';
  const { sources, calls } = fakeSources({
    'Railway pricing @railway.com': [result('https://railway.com/pricing', railwayPage)],
    'Railway Hobby plan Postgres storage': [result('https://getdeploying.com/railway'), result('https://docs.railway.com/volumes')],
  });
  const check = {
    vendor: 'Railway',
    domain: 'railway.com',
    officialUrl: 'https://railway.com/pricing',
    attributes: ['Hobby plan monthly cost', 'Hobby plan usage credit', 'Hobby plan Postgres storage'],
  };
  const evidence = await findEvidence([check], sources);
  expect(calls).toEqual([
    'search Railway pricing @railway.com',
    'extract https://railway.com/pricing',
    'search Railway Hobby plan Postgres storage',
  ]);
  expect(evidence.map((r) => [r.url, r.sourceType])).toEqual([
    ['https://railway.com/pricing', 'official'],
    ['https://getdeploying.com/railway', 'third_party'],
  ]);
});

test('third-party searches are capped at 2 per turn, across all vendors', async () => {
  const { sources, calls } = fakeSources({});
  await findEvidence(
    [
      { vendor: 'Neon', domain: 'neon.com', attributes: ['Launch compute', 'Scale compute'] },
      { vendor: 'Supabase', domain: 'supabase.com', attributes: ['Pro storage'] },
    ],
    sources,
  );
  const thirdPartySearches = calls.filter((call) => call.startsWith('search') && !call.includes('@'));
  expect(thirdPartySearches).toEqual(['search Neon Launch compute', 'search Neon Scale compute']);
});

test('a long official page gives the model a passage for each claim, not one window around the most prices', () => {
  const faq = 'Is the Hobby plan free? No. The Hobby plan is $5 a month with $5 of usage credit. '.repeat(8);
  const table = [
    '| Plan | **RAM** | **Ephemeral Storage** | **Volume Storage** |',
    '| **Free** | **0.5 GB** | **1 GB** | **0.5 GB** |',
    '| **Hobby** | **48 GB** | **100 GB** | **5 GB** |',
  ].join('\n');
  const page = `${'Intro text about deploying apps. '.repeat(40)}${table}\n${'Other docs. '.repeat(60)}${faq}`;
  const passage = passagePerClaim(page, ['Hobby plan monthly cost', 'Hobby plan Postgres storage'], 'Railway');
  expect(passage).toContain('| **Hobby** | **48 GB** | **100 GB** | **5 GB** |');
  expect(passage).toContain('**Volume Storage**');
  expect(passage).toContain('$5 a month');
  expect(passage.length).toBeLessThanOrEqual(1810);
  expect(passagePerClaim('A short page.', ['anything'], 'X')).toBe('A short page.');
});

test('official pages rank by type: pricing and docs first, blog and news last', () => {
  expect(pageTypeRank('https://neon.com/pricing')).toBe(0);
  expect(pageTypeRank('https://neon.com/docs/introduction/plans')).toBe(0);
  expect(pageTypeRank('https://docs.railway.com/pricing/plans')).toBe(0);
  expect(pageTypeRank('https://railway.com/about')).toBe(1);
  expect(pageTypeRank('https://neon.com/blog/new-usage-based-pricing')).toBe(2);
  expect(pageTypeRank('https://supabase.com/news/pricing-update')).toBe(2);
  expect(pageTypeRank('https://railway.com/pricing-explained', 'https://railway.com/pricing-explained')).toBe(0);
});
