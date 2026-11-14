import { wordsOf } from './official';
import { flattenTables } from './tables';
import { bestPassage } from './web-search-tool';

const CLAIM_PAGE_CHARS = 1800;
const TABLE_SHARE_CHARS = 900;
const CHARS_PER_CLAIM = 450;
const PASSAGE_LEAD_IN_CHARS = 120;
const GENERIC_ATTRIBUTE_WORDS = new Set([
  'the', 'and', 'for', 'per', 'plan', 'plans', 'price', 'pricing', 'cost', 'costs', 'monthly', 'month', 'fee', 'tier', 'limit',
]);

type Span = { start: number; end: number };

export const distinctiveWords = (attribute: string) =>
  wordsOf(attribute).filter((word) => word.length > 2 && !GENERIC_ATTRIBUTE_WORDS.has(word));

function windowCovering(content: string, words: string[], chars: number): Span | undefined {
  const lower = content.toLowerCase();
  const hits = words.flatMap((word) => {
    const found: { at: number; word: string }[] = [];
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) found.push({ at, word });
    return found;
  });
  if (!hits.length) return undefined;
  const score = (start: number) => {
    const inside = hits.filter((hit) => hit.at >= start && hit.at < start + chars);
    return new Set(inside.map((hit) => hit.word)).size * hits.length + inside.length;
  };
  const starts = hits.map((hit) => Math.max(0, Math.min(hit.at - PASSAGE_LEAD_IN_CHARS, content.length - chars)));
  const start = starts.reduce((best, candidate) => (score(candidate) > score(best) ? candidate : best));
  return { start, end: start + chars };
}

function mergedWindows(content: string, attributes: string[]): Span[] {
  const windows = attributes
    .map(distinctiveWords)
    .filter((words) => words.length)
    .map((words) => windowCovering(content, words, CHARS_PER_CLAIM))
    .filter((window): window is Span => window !== undefined)
    .sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  }
  return merged;
}

function takeUpTo(pieces: string[], chars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const piece of pieces) {
    if (used + piece.length > chars) break;
    kept.push(piece);
    used += piece.length;
  }
  return kept;
}

export function passagePerClaim(content: string, attributes: string[], focus: string): string {
  const { text, rows } = flattenTables(content);
  if (text.length <= CLAIM_PAGE_CHARS) return text;
  const words = [...new Set(attributes.flatMap(distinctiveWords))];
  const relevance = (row: string) => {
    const label = row.split(' | ')[0].toLowerCase();
    const lower = row.toLowerCase();
    return words.filter((word) => label.includes(word)).length * 2 + words.filter((word) => lower.includes(word)).length;
  };
  const matchingRows = takeUpTo(
    rows
      .map((row, position) => ({ row, position, score: relevance(row) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.position - b.position)
      .map(({ row }) => row),
    TABLE_SHARE_CHARS,
  );
  const rowChars = matchingRows.reduce((sum, row) => sum + row.length, 0);
  const windows = mergedWindows(text, attributes).map(({ start, end }) => `…${text.slice(start, end)}…`);
  const pieces = [matchingRows.join('\n'), ...takeUpTo(windows, CLAIM_PAGE_CHARS - rowChars)].filter(Boolean);
  return pieces.length ? pieces.join('\n\n') : bestPassage(text, focus, CLAIM_PAGE_CHARS);
}
