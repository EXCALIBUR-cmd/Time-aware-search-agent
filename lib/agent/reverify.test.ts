import { expect, test } from 'vitest';
import type { MemoryClaim } from '../memory/recall';
import type { NumberedResult } from '../search/web-search-tool';
import { atMostTwoSentences, checkRows, claimsToCompare, quoteAppearsIn, renderTable, renderVerdict, type CheckedRow, type ClaimRow } from './reverify';
import { compareValues, containsValue } from './values';

const tz = 'Asia/Kolkata';
const since = 'these prices were checked on 3 to 13 Nov';
const RAILWAY_TABLE_ROW = '| **Hobby** | **6** | **48 GB** | **48 vCPU** | **100 GB** | **5 GB** | **100 GB** |';

const railwayPage: NumberedResult = {
  n: 6,
  title: 'Pricing Plans | Railway Docs',
  url: 'https://docs.railway.com/pricing/plans',
  sourceType: 'official',
  content: [
    '| Plan | **Replicas** | **RAM** | **CPU** | **Ephemeral Storage** | **Volume Storage** | **Image Size** |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    RAILWAY_TABLE_ROW,
    'No. The Hobby Plan is $5 a month, and it includes a resource usage credit of $5.',
  ].join('\n'),
};

const claim = (subject: string, attribute: string, value: string, checkedAt = '2026-11-03T07:09:00.000Z'): MemoryClaim => ({
  subject,
  attribute,
  value,
  source_url: 'https://getdeploying.com/railway',
  checked_at: checkedAt,
  source_type: 'third_party',
});

const rows: ClaimRow[] = claimsToCompare([
  claim('Railway', 'Hobby plan monthly cost', '$5 per month'),
  claim('Railway', 'Hobby plan Postgres storage', '1 GB'),
]);

test('a value is accepted only when its quote is really in the source and contains the value', () => {
  const quoted = (now_value: string, quote: string) =>
    checkRows(rows, [{ claim_id: 'c2', now_value, quote, source_url: railwayPage.url }], [railwayPage])[1];

  expect(quoted('5 GB', RAILWAY_TABLE_ROW)).toMatchObject({ now: '5 GB', changed: 'yes' });
  expect(quoted('5 GB', '| **Hobby** | **6** | **48 GB** | 5 GB volume |')).toMatchObject({ now: null, changed: 'unknown' });
  expect(quoted('2 GB', RAILWAY_TABLE_ROW)).toMatchObject({ now: null, changed: 'unknown' });
  expect(quoted('8 GB', RAILWAY_TABLE_ROW)).toMatchObject({ now: null, changed: 'unknown' });
  const wrongSource = checkRows(rows, [{ claim_id: 'c2', now_value: '5 GB', quote: RAILWAY_TABLE_ROW, source_url: 'https://elsewhere.example' }], [railwayPage]);
  expect(wrongSource[1].changed).toBe('unknown');
  expect(checkRows(rows, [{ claim_id: 'c2', now_value: null, quote: null, source_url: null }], [railwayPage])[1].now).toBeNull();
});

test('unit and currency variants compare as equal; real differences do not', () => {
  expect(compareValues('$5/mo', '$5 per month')).toBe('no');
  expect(compareValues('$5 a month', '$5/month')).toBe('no');
  expect(compareValues('5GB', '5 GB')).toBe('no');
  expect(compareValues('1 TB', '1000 GB')).toBe('no');
  expect(compareValues('$0.106 per CU‑hour', '$0.106 /CU-hour')).toBe('no');
  expect(compareValues('$5 credit', '$5')).toBe('no');
  expect(compareValues('None', 'none')).toBe('no');
  expect(compareValues('$25 per month', '$29 per month')).toBe('yes');
  expect(compareValues('1 GB', '5 GB')).toBe('yes');
  expect(compareValues('None', '$5 per month')).toBe('yes');
  expect(compareValues('$5 per month', '€5 per month')).toBe('unknown');
  expect(compareValues('$5 per month', null)).toBe('unknown');
  expect(containsValue('The Hobby Plan is $5 a month.', '$5/mo')).toBe(true);
  expect(containsValue('Limit: 45 GB of storage', '5 GB')).toBe(false);
  expect(containsValue('it includes a resource usage credit of $5.', '$5 credit')).toBe(true);
  expect(containsValue('Launch: $0.106/CU‑hour', '$0.106 per CU-hour')).toBe(true);
});

test('the verdict always matches the table', () => {
  const row = (changed: CheckedRow['changed'], i: number): CheckedRow => ({
    ...claim('Vendor', `figure ${i}`, '$1'),
    id: `c${i}`,
    now: changed === 'unknown' ? null : '$1',
    changed,
  });
  const cases: CheckedRow['changed'][][] = [[], ['no'], ['no', 'no'], ['yes'], ['yes', 'no', 'yes'], ['unknown', 'no'], ['yes', 'unknown', 'unknown']];
  for (const changes of cases) {
    const checked = changes.map(row);
    const table = renderTable(checked, tz);
    const verdict = renderVerdict(checked, since);
    const yes = (table.match(/\| Yes \|/g) ?? []).length;
    const unknown = (table.match(/\| Unknown \|/g) ?? []).length;
    const words = ['Nothing', 'One', 'Two', 'Three'];
    expect(verdict.startsWith(yes ? `**${words[yes]} price${yes === 1 ? '' : 's'} changed` : '**Nothing has changed')).toBe(true);
    expect(verdict.includes("couldn't be confirmed")).toBe(unknown > 0);
    if (unknown) expect(verdict).toContain(`${words[unknown].toLowerCase()} price${unknown === 1 ? '' : 's'} couldn't be confirmed`);
  }
});

test('Railway Hobby storage 1 GB → 5 GB shows as changed, and $5 a month as unchanged', () => {
  const checked = checkRows(
    rows,
    [
      { claim_id: 'c1', now_value: '$5 a month', quote: 'No. The Hobby Plan is $5 a month, and it includes a resource usage credit of $5.', source_url: railwayPage.url },
      { claim_id: 'c2', now_value: '5 GB', quote: RAILWAY_TABLE_ROW, source_url: railwayPage.url },
    ],
    [railwayPage],
  );
  expect(checked.map((r) => [r.attribute, r.changed])).toEqual([
    ['Hobby plan monthly cost', 'no'],
    ['Hobby plan Postgres storage', 'yes'],
  ]);
  expect(renderVerdict(checked, since)).toBe('**One price changed since these prices were checked on 3 to 13 Nov.**');
  expect(renderTable(checked, tz)).toContain('| Railway · Hobby plan Postgres storage | 1 GB (3 Nov) | 5 GB | Yes | [6] |');
});

test('a quote with a plain hyphen matches a source that uses a non-breaking one', () => {
  const neon: NumberedResult = { n: 1, title: 'Neon', url: 'https://neon.com/docs/introduction/plans', sourceType: 'official', content: 'Storage: $0.35 per GB\u2011month' };
  const neonRows = claimsToCompare([claim('Neon', 'Launch plan storage price', '$0.35 per GB-month')]);
  const [row] = checkRows(neonRows, [{ claim_id: 'c1', now_value: '$0.35 per GB-month', quote: 'Storage: $0.35 per GB-month', source_url: neon.url }], [neon]);
  expect(row).toMatchObject({ now: '$0.35 per GB-month', changed: 'no' });
});

test('claims saved under longer names merge with the same claim, keeping the newest value and the shortest name', () => {
  const merged = claimsToCompare([
    claim('Railway', 'Hobby plan Postgres storage', '1 GB'),
    claim('Railway Hobby plan Postgres storage', 'limit', '1 GB', '2026-11-13T15:07:00.000Z'),
    claim('Railway', 'Hobby plan usage credit', '$5 credit'),
  ]);
  expect(merged.map((r) => [r.subject, r.attribute, r.checked_at.slice(0, 10)])).toEqual([
    ['Railway', 'Hobby plan Postgres storage', '2026-11-13'],
    ['Railway', 'Hobby plan usage credit', '2026-11-03'],
  ]);
});

test('claims repeated across conversations become one row with the latest value', () => {
  const merged = claimsToCompare([
    claim('Neon', 'Launch compute price', '$0.10 per CU-hour', '2026-11-01T09:00:00.000Z'),
    claim('Neon', 'Launch compute price', '$0.106 per CU-hour', '2026-11-03T09:00:00.000Z'),
    claim('Supabase', 'Pro plan monthly cost', '$25 per month'),
  ]);
  expect(merged.map((r) => [r.id, r.subject, r.value])).toEqual([
    ['c1', 'Neon', '$0.106 per CU-hour'],
    ['c2', 'Supabase', '$25 per month'],
  ]);
});

test('a table quote may leave out cells, but every cell it keeps must be in one row of the source, in order', () => {
  const supabase = '| Database Size | 500 MB | 8 GB disk per project included | Custom |\n| Storage Size | 1 GB | 100 GB included | Custom |';
  expect(quoteAppearsIn(supabase, 'Database Size | 8 GB disk per project included')).toBe(true);
  expect(quoteAppearsIn(supabase, '| Storage Size | 100 GB included |')).toBe(true);
  expect(quoteAppearsIn(supabase, 'Database Size | 100 GB included')).toBe(false);
  expect(quoteAppearsIn(supabase, '8 GB disk per project included | Database Size')).toBe(false);
  expect(quoteAppearsIn(supabase, 'Database Size | 9 GB disk per project included')).toBe(false);
  expect(quoteAppearsIn('Plan | Price\nHobby | $5 / month', 'Plan | Price … Hobby | $5 / month')).toBe(false);
});

test('the context keeps at most two sentences, without breaking a price at its decimal point', () => {
  const answer = 'Neon now bills $0.14 per CU-hour, up from $0.106. The change took effect in November. Railway is unchanged.\n| a | b |\n# Heading';
  expect(atMostTwoSentences(answer)).toBe('Neon now bills $0.14 per CU-hour, up from $0.106. The change took effect in November.');
  expect(atMostTwoSentences('Storage rose to 5 GB on the Hobby plan.')).toBe('Storage rose to 5 GB on the Hobby plan.');
});

const neonDocs: NumberedResult = {
  n: 1,
  title: 'Neon plans',
  url: 'https://neon.com/docs/introduction/plans',
  sourceType: 'official',
  content: 'Launch: $0.106/CU-hour',
};
const neonBlog: NumberedResult = {
  n: 2,
  title: 'Neon blog',
  url: 'https://neon.com/blog/new-usage-based-pricing',
  sourceType: 'official',
  content: 'Pay-as-you-go compute at $0.14 per CU-hour.',
};
const neonRows = claimsToCompare([claim('Neon', 'Launch plan compute price', '$0.106 per CU-hour')]);

test('two official sources with different values are a conflict, not a change', () => {
  const [row] = checkRows(
    neonRows,
    [
      { claim_id: 'c1', now_value: '$0.14 per CU-hour', quote: 'Pay-as-you-go compute at $0.14 per CU-hour.', source_url: neonBlog.url },
      { claim_id: 'c1', now_value: '$0.106/CU-hour', quote: 'Launch: $0.106/CU-hour', source_url: neonDocs.url },
    ],
    [neonDocs, neonBlog],
  );
  expect(row).toMatchObject({ now: null, changed: 'unknown' });
  const table = renderTable([row], tz);
  expect(table).toContain(
    'Conflicting sources: $0.106/CU-hour (https://neon.com/docs/introduction/plans) vs $0.14 per CU-hour (https://neon.com/blog/new-usage-based-pricing)',
  );
  expect(table).toContain('| Unknown | [1], [2] |');
  expect(renderVerdict([row], since)).toBe('**Nothing has changed since these prices were checked on 3 to 13 Nov; one price has conflicting sources.**');
});

test('when official sources agree, the pricing or docs page is the one cited, not the blog', () => {
  const blogAgreeing = { ...neonBlog, content: 'Launch compute is $0.106 per CU-hour.' };
  const [row] = checkRows(
    neonRows,
    [
      { claim_id: 'c1', now_value: '$0.106 per CU-hour', quote: 'Launch compute is $0.106 per CU-hour.', source_url: blogAgreeing.url },
      { claim_id: 'c1', now_value: '$0.106/CU-hour', quote: 'Launch: $0.106/CU-hour', source_url: neonDocs.url },
    ],
    [blogAgreeing, neonDocs],
  );
  expect(row).toMatchObject({ changed: 'no', now: '$0.106/CU-hour' });
  expect(row.source?.url).toBe(neonDocs.url);
});
