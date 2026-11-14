import { expect, test } from 'vitest';
import { checkRows, claimsToCompare } from '../agent/reverify';
import { passagePerClaim } from './passages';
import { flattenTables } from './tables';

const RAILWAY_PLANS = [
  'Depending on the plan you are on, you are allowed to use up these resources per service.',
  '',
  '| Plan | **Replicas** | **RAM** | **CPU** | **Ephemeral Storage** | **Volume Storage** | **Image Size** |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| **Trial** | **2** | **1 GB** | **2 vCPU** | **1 GB** | **0.5 GB** | **4 GB** |',
  '| **Hobby** | **6** | **48 GB** | **48 vCPU** | **100 GB** | **5 GB** | **100 GB** |',
  '',
  '| Plan | Price |',
  '| --- | --- |',
  '| **Hobby** | $5 / month |',
].join('\n');

const HOBBY_LIMITS = 'Hobby | Replicas: 6 | RAM: 48 GB | CPU: 48 vCPU | Ephemeral Storage: 100 GB | Volume Storage: 5 GB | Image Size: 100 GB';

test('a markdown table becomes one line per row, each cell labelled with its column header', () => {
  const { text, rows } = flattenTables(RAILWAY_PLANS);
  expect(rows).toEqual([
    'Trial | Replicas: 2 | RAM: 1 GB | CPU: 2 vCPU | Ephemeral Storage: 1 GB | Volume Storage: 0.5 GB | Image Size: 4 GB',
    HOBBY_LIMITS,
    'Hobby | Price: $5 / month',
  ]);
  expect(text).toContain('Depending on the plan you are on');
  expect(text).not.toContain('| --- |');
});

test('an HTML table is flattened the same way', () => {
  const html = '<p>Plans</p><table><tr><th>Plan</th><th>Price</th><th>Storage</th></tr><tr><td><b>Pro</b></td><td>$25&nbsp;/ month</td><td>8 GB</td></tr></table>';
  expect(flattenTables(html).rows).toEqual(['Pro | Price: $25 / month | Storage: 8 GB']);
});

test('a table without a separator line is left alone', () => {
  const loose = '| a | b |\n| c | d |';
  expect(flattenTables(loose)).toEqual({ text: loose, rows: [] });
});

test('the passage for a long page leads with the labelled rows the claims are about', () => {
  const page = `${'Navigation: Data & storage, PostgreSQL, Volumes. '.repeat(60)}\n${RAILWAY_PLANS}\n${'FAQ: The Hobby plan is $5 a month. '.repeat(40)}`;
  const passage = passagePerClaim(page, ['Hobby plan Postgres storage', 'Hobby plan monthly cost'], 'Railway');
  expect(passage.startsWith(`${HOBBY_LIMITS}\nHobby | Price: $5 / month`)).toBe(true);
});

test('a quote taken from a labelled row is accepted, and Railway storage 1 GB -> 5 GB is a change', () => {
  const source = { n: 6, title: 'Railway plans', url: 'https://docs.railway.com/pricing/plans', sourceType: 'official' as const, content: flattenTables(RAILWAY_PLANS).text };
  const rows = claimsToCompare([
    { subject: 'Railway', attribute: 'Hobby plan Postgres storage', value: '1 GB', source_url: null, checked_at: '2026-11-03T07:09:00.000Z', source_type: null },
  ]);
  const [row] = checkRows(rows, [{ claim_id: 'c1', now_value: '5 GB', quote: 'Hobby | Volume Storage: 5 GB', source_url: source.url }], [source]);
  expect(row).toMatchObject({ now: '5 GB', changed: 'yes' });
  const [misread] = checkRows(rows, [{ claim_id: 'c1', now_value: '0.5 GB', quote: 'Hobby | Volume Storage: 0.5 GB', source_url: source.url }], [source]);
  expect(misread.changed).toBe('unknown');
});
