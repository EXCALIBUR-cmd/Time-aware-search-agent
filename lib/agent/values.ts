export type Changed = 'yes' | 'no' | 'unknown';

type Measure = { currency: string; amount: number; sized: boolean; rate: string } | { text: string };

const SIZE_IN_GB: Record<string, number> = { kb: 1e-6, mb: 1e-3, gb: 1, tb: 1000 };
const MEASURE = /([$€£₹])?\s?(\d+(?:\.\d+)?)\s?(tb|gb|mb|kb)?(\/[a-z][a-z-]*)?/;

export const normaliseQuoteText = (text: string) =>
  text
    .replace(/[*_`]/g, '')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

export function canonicalValue(text: string): string {
  return normaliseQuoteText(text)
    .toLowerCase()
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    .replace(/\bus\$/g, '$')
    .replace(/(\d)\s*(tb|gb|mb|kb)\b/g, '$1 $2')
    .replace(/\s*(?:\/|\bper\b|\ba\b)\s*(?:mo|mon|month)\b/g, '/month')
    .replace(/\s+monthly\b/g, '/month')
    .replace(/\s*\bper\s+/g, '/')
    .replace(/\s*\/\s*/g, '/');
}

function measure(value: string): Measure {
  const canonical = canonicalValue(value);
  const match = MEASURE.exec(canonical);
  if (!match) return { text: canonical };
  const [, currency = '', amount, size, rate = ''] = match;
  return { currency, amount: Number(amount) * (size ? SIZE_IN_GB[size] : 1), sized: Boolean(size), rate };
}

export function compareValues(then: string, now: string | null): Changed {
  if (now === null) return 'unknown';
  const before = measure(then);
  const after = measure(now);
  if ('text' in before || 'text' in after) {
    if ('text' in before && 'text' in after) return before.text === after.text ? 'no' : 'unknown';
    return 'yes';
  }
  const currenciesDiffer = before.currency && after.currency && before.currency !== after.currency;
  if (currenciesDiffer) return 'unknown';
  if (before.amount !== after.amount) return 'yes';
  const ratesDiffer = before.rate && after.rate && before.rate !== after.rate;
  return ratesDiffer ? 'unknown' : 'no';
}

export function containsValue(quote: string, value: string): boolean {
  const haystack = canonicalValue(quote);
  const canonical = canonicalValue(value);
  const needle = MEASURE.exec(canonical)?.[0].trim() || canonical;
  if (!needle) return false;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1] ?? ' ';
    const after = haystack[at + needle.length] ?? ' ';
    if (!/[0-9.]/.test(before) && !/[0-9]/.test(after)) return true;
  }
  return false;
}
