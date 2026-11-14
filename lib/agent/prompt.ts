import { formatInTimeZone } from 'date-fns-tz';
import type { Mode } from './router';

function dayRange(earliest: string, latest: string, tz: string): string {
  const day = (d: string, pattern: string) => formatInTimeZone(d, tz, pattern);
  if (day(earliest, 'yyyy-MM-dd') === day(latest, 'yyyy-MM-dd')) return day(earliest, 'EEE d MMM');
  const sameMonth = day(earliest, 'yyyy-MM') === day(latest, 'yyyy-MM');
  return `${day(earliest, sameMonth ? 'd' : 'd MMM')} to ${day(latest, 'd MMM')}`;
}

export function verdictSince(claimsCheckedAt: string[], askedDays: Date[], tz: string): string | undefined {
  const checked = [...claimsCheckedAt].sort();
  if (checked.length) return `these prices were checked on ${dayRange(checked[0], checked[checked.length - 1], tz)}`;
  const earliestAskedDay = [...askedDays].sort((a, b) => a.getTime() - b.getTime())[0];
  return earliestAskedDay ? formatInTimeZone(earliestAskedDay, tz, 'EEE d MMM') : undefined;
}

export type InstructionInput ={ mode: Mode; now: Date; tz: string; searchedAlready: boolean; verdictSince?: string };

const reverifyAnswer = (since: string) =>
  `Start the answer with one bold sentence that gives the verdict, for example "**Nothing has changed since ${since}.**" or "**Two prices changed since ${since}.**". End that sentence with "since ${since}." copied word for word; do not reword or reformat the date. Then the table: Subject · Then (date) · Now · Changed? · Source. No heading or title anywhere in the answer. Mark unclear evidence "Couldn't confirm"; never guess.`;

function whenNotSearchedYet(mode: Mode, since: string): string {
  if (mode === 'chat') return 'This turn: reply briefly and directly. No search is available.';
  if (mode === 'fresh') {
    return 'This turn: call web_search once (up to 4 queries) if you need current information. Skip it when the conversation so far already answers the question.';
  }
  if (mode === 'recall') {
    return 'This turn: answer from <user_profile>, <memory> and the conversation so far, giving the date of each past conversation you mention. No search is available. If the user is telling you something rather than asking, just acknowledge it.';
  }
  return `This turn: re-verify the claims in <memory>. Call web_search once with one query per claim subject (for example "Neon Postgres pricing"), up to 4. ${reverifyAnswer(since)}`;
}

function whenAlreadySearched(mode: Mode, since: string): string | undefined {
  if (mode === 'fresh') {
    return 'This turn: the web has already been searched for you and the results are in <search_results>, numbered [n]. Answer from them, citing each fact as [n] and ending with the Sources list. Call web_search once more only if they do not answer the question.';
  }
  if (mode === 'reverify') {
    return `This turn: re-verify the claims in <memory> against <search_results>, fetched for you just now and numbered [n]. ${reverifyAnswer(since)} Cite each "Now" value as [n] and end with the Sources list. Each result is marked (official) or (third-party source): take every "Now" value from an official result, and use a third-party result only when no official result answers that row, writing "(third-party source)" after its citation in the Source cell. Call web_search once more only for a subject the results do not cover.`;
  }
  return undefined;
}

export function buildInstructions(p: InstructionInput): string {
  const since = p.verdictSince ?? 'then';
  const thisTurn = (p.searchedAlready && whenAlreadySearched(p.mode, since)) || whenNotSearchedYet(p.mode, since);
  return [
    'You are a concise chat agent with web search and a dated memory of past conversations.',
    `Today is ${formatInTimeZone(p.now, p.tz, 'EEEE, d MMMM yyyy, HH:mm')} in ${p.tz}.`,
    `Rules:
- Answer first, then detail. Short by default; use a markdown table for comparisons.
- Cite every fact from search inline as [n], using the n of the result it came from. End with a "Sources" list of only the results you cited, each listed once: [n] [title](url), with the date checked.
- Never state a past conversation that is not in <memory>. If memory has nothing for the requested time, say you have no record of it and offer to look it up now.
- Things from <memory> or <user_profile> are not search results: no [n] and no Sources list for them. Give the date exactly as <memory> writes it, in a sentence; a table only for three or more items.
- <user_profile> holds what the user has told you about themselves, newest value per fact; trust it over older messages and never search the web for it. If <memory> shows an older, different value, the fact changed: say so when asked.
- When something has changed, lead with the change.
- Ask one clarifying question only when the request cannot be answered otherwise.`,
    thisTurn,
  ].join('\n\n');
}
