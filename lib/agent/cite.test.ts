import { beforeEach, expect, test, vi } from 'vitest';
import type { NumberedResult } from '../search/web-search-tool';

const reply = vi.hoisted(() => ({ text: '' }));
vi.mock('./reverify-answer', () => ({ askModel: async () => reply.text }));

const { citesASource, requireInlineCitations, withSourceLinks } = await import('./cite');

const nextjs: NumberedResult = { n: 1, title: 'Next.js 16.4', url: 'https://nextjs.org/blog/next-16-4', content: 'Next.js 16.4.0 was released on 6 Oct 2026.' };
const models = { main: 'main/model', fast: 'fast/model' };
const fallbackAnswer = '**16.4.0** (released 6 Oct 2026)\n\nSources\n[1] Next.js Updates by Vercel – 16.4.0 release announcement';

beforeEach(() => {
  reply.text = '';
});

test('an answer cites a source only with an inline [n] that matches a search result', () => {
  expect(citesASource('Next.js 16.4.0 is out [1].', [nextjs])).toBe(true);
  expect(citesASource('Next.js 16.4.0 is out [7].', [nextjs])).toBe(false);
  expect(citesASource('Next.js 16.4.0 is out.', [nextjs])).toBe(false);
});

test('cited results get links: a link-less Sources section is replaced by one built from the results', () => {
  const linked = withSourceLinks('The latest is **16.4.0** [1].\n\nSources\n[1] Next.js Updates by Vercel', [nextjs]);
  expect(linked).toBe('The latest is **16.4.0** [1].\n\n**Sources**\n[1] [Next.js 16.4](https://nextjs.org/blog/next-16-4)');
  const already = 'It is 16.4.0 [1].\n\nSources: [1] [Next.js](https://nextjs.org/blog)';
  expect(withSourceLinks(already, [nextjs])).toBe(already);
});

test('an answer without inline citations is re-asked once, and the cited version is used', async () => {
  reply.text = 'The latest stable version is **16.4.0**, released on 6 Oct 2026 [1].';
  const result = await requireInlineCitations(fallbackAnswer, [nextjs], models, () => undefined);
  expect(result).toBe(
    'The latest stable version is **16.4.0**, released on 6 Oct 2026 [1].\n\n**Sources**\n[1] [Next.js 16.4](https://nextjs.org/blog/next-16-4)',
  );
});

test('if the re-ask still has no citations, the original answer stays and is reported', async () => {
  reply.text = 'The latest stable version is 16.4.0.';
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await requireInlineCitations(fallbackAnswer, [nextjs], models, () => undefined)).toBe(fallbackAnswer);
  expect(errors).toHaveBeenCalledWith('[agent] the answer used search but has no inline [n] citations, even after one re-ask');
  errors.mockRestore();
});

test('an answer that did not use search is left alone', async () => {
  expect(await requireInlineCitations('You are welcome!', [], models, () => undefined)).toBe('You are welcome!');
});

test('a [n] that appears only in the Sources list is not an inline citation', () => {
  expect(citesASource(fallbackAnswer, [nextjs])).toBe(false);
  expect(citesASource('It is 16.4.0 [1].\n\n**Sources**\n[1] Next.js', [nextjs])).toBe(true);
});
