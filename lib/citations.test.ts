import { expect, test } from 'vitest';
import { buildInstructions, verdictSince } from './agent/prompt';
import { citedNumbers, citedSources, withoutSourcesSection } from './citations';

const source = (sourceId: string, url: string) => ({ sourceId, url });

test('only the sources the answer cites are shown, each URL once, in their original order', () => {
  const answer = 'Neon is unchanged [2]. Supabase too [5][2]. Railway (third-party source) [7].';
  const sources = [
    source('1', 'https://neon.com/blog'),
    source('2', 'https://neon.com/pricing'),
    source('5', 'https://supabase.com/pricing'),
    source('6', 'https://railway.com/pricing'),
    source('7', 'https://getdeploying.com/railway'),
    source('8', 'https://neon.com/pricing'),
  ];
  expect([...citedNumbers(answer)]).toEqual(['2', '5', '7']);
  expect(citedSources(answer, sources).map((s) => s.sourceId)).toEqual(['2', '5', '7']);
  expect(citedSources('No citations here.', sources)).toEqual([]);
});

test('a re-verification answer is told to lead with a dated verdict and to carry no heading', () => {
  const instructions = buildInstructions({
    mode: 'reverify',
    now: new Date('2026-11-14T10:00:00+05:30'),
    tz: 'Asia/Kolkata',
    searchedAlready: true,
    verdictSince: 'Tue 10 Nov',
  });
  expect(instructions).toContain('"**Nothing has changed since Tue 10 Nov.**"');
  expect(instructions).toContain('with N replaced by exactly how many rows say "Yes"');
  expect(instructions).toContain(`"Couldn't confirm" is not a change.`);
  expect(instructions).not.toContain('Two prices changed');
  expect(instructions).toContain('No heading or title anywhere in the answer.');
  expect(instructions).toContain('a markdown table with the columns | Subject | Then (date) | Now | Changed? | Source |');
  expect(instructions).not.toContain(' · ');
  expect(instructions).toContain('End with a "Sources" list of only the results you cited, each listed once');
});

test('the verdict is dated from when the claims were checked, as a range when the dates differ', () => {
  const tz = 'Asia/Kolkata';
  const askedAbout = [new Date('2026-11-10T00:00:00+05:30')];
  const sameDay = ['2026-11-03T07:09:00.000Z', '2026-11-03T15:04:00.000Z'];
  expect(verdictSince(sameDay, askedAbout, tz)).toBe('these prices were checked on Tue 3 Nov');
  expect(verdictSince([...sameDay, '2026-11-10T09:00:00.000Z'], askedAbout, tz)).toBe('these prices were checked on 3 to 10 Nov');
  expect(verdictSince(['2026-10-28T09:00:00.000Z', '2026-11-03T09:00:00.000Z'], [], tz)).toBe(
    'these prices were checked on 28 Oct to 3 Nov',
  );
  expect(verdictSince([], askedAbout, tz)).toBe('Tue 10 Nov');
  expect(verdictSince([], [], tz)).toBeUndefined();
});

test('the verdict sentence reads naturally with a claim date', () => {
  const instructions = buildInstructions({
    mode: 'reverify',
    now: new Date('2026-11-14T10:00:00+05:30'),
    tz: 'Asia/Kolkata',
    searchedAlready: true,
    verdictSince: 'these prices were checked on Tue 3 Nov',
  });
  expect(instructions).toContain('"**Nothing has changed since these prices were checked on Tue 3 Nov.**"');
  expect(instructions).toContain('End that sentence with "since these prices were checked on Tue 3 Nov." copied word for word');
});

test('other modes get no verdict instruction', () => {
  const fresh = buildInstructions({ mode: 'fresh', now: new Date(), tz: 'Asia/Kolkata', searchedAlready: true });
  expect(fresh).not.toContain('verdict');
});

test('the text Sources section is cut off in every format the agent writes, and nothing else is', () => {
  const body = 'Neon Launch is $19/month [1].';
  expect(withoutSourcesSection(`${body}\n\nSources: [1] https://neon.com/pricing (checked 3 Nov 2026)`)).toBe(body);
  expect(withoutSourcesSection(`${body}\n\n**Sources** [1] [Neon pricing](https://neon.com/pricing)`)).toBe(body);
  expect(withoutSourcesSection(`${body}\n\n**Sources:**\n- [1] [Neon pricing](https://neon.com/pricing)`)).toBe(body);
  const mentionsSources = `${body}\nSources say Neon may change pricing soon.`;
  expect(withoutSourcesSection(mentionsSources)).toBe(mentionsSources);
});
