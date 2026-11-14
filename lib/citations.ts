export const citedNumbers = (text: string): Set<string> => new Set([...text.matchAll(/\[(\d+)\]/g)].map((match) => match[1]));

export function citedSources<Source extends { sourceId: string; url: string }>(text: string, sources: Source[]): Source[] {
  const cited = citedNumbers(text);
  const seenUrls = new Set<string>();
  return sources.filter((source) => {
    if (!cited.has(source.sourceId) || seenUrls.has(source.url)) return false;
    seenUrls.add(source.url);
    return true;
  });
}

const SOURCES_SECTION = /\n\s*\**sources\**:?\**[ \t]*(?=\[|\n|$)[\s\S]*$/i;

export const withoutSourcesSection = (text: string): string => text.replace(SOURCES_SECTION, '').trimEnd();
