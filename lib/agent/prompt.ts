import { formatInTimeZone } from 'date-fns-tz';
import type { Mode } from './router';

const REVERIFY_ANSWER = `Answer with a table: Subject · Then (date) · Now · Changed? · Source. Mark unclear evidence "Couldn't confirm"; never guess.`;

const WHEN_NOT_SEARCHED_YET: Record<Mode, string> = {
  chat: 'This turn: reply briefly and directly. No search is available.',
  fresh:
    'This turn: call web_search once (up to 4 queries) if you need current information. Skip it when the conversation so far already answers the question.',
  recall:
    'This turn: answer from <user_profile>, <memory> and the conversation so far, giving the date of each past conversation you mention. No search is available. If the user is telling you something rather than asking, just acknowledge it.',
  reverify: `This turn: re-verify the claims in <memory>. Call web_search once with one query per claim subject (for example "Neon Postgres pricing"), up to 4. ${REVERIFY_ANSWER}`,
};

const WHEN_ALREADY_SEARCHED: Partial<Record<Mode, string>> = {
  fresh:
    'This turn: the web has already been searched for you and the results are in <search_results>, numbered [n]. Answer from them, citing each fact as [n] and ending with the Sources list. Call web_search once more only if they do not answer the question.',
  reverify: `This turn: re-verify the claims in <memory> against <search_results>, fetched for you just now and numbered [n]. ${REVERIFY_ANSWER} Cite each "Now" value as [n] and end with the Sources list. Call web_search once more only for a subject the results do not cover.`,
};

export function buildInstructions(p: { mode: Mode; now: Date; tz: string; searchedAlready: boolean }): string {
  const thisTurn = (p.searchedAlready && WHEN_ALREADY_SEARCHED[p.mode]) || WHEN_NOT_SEARCHED_YET[p.mode];
  return [
    'You are a concise chat agent with web search and a dated memory of past conversations.',
    `Today is ${formatInTimeZone(p.now, p.tz, 'EEEE, d MMMM yyyy, HH:mm')} in ${p.tz}.`,
    `Rules:
- Answer first, then detail. Short by default; use a markdown table for comparisons.
- Cite every fact from search inline as [n], using the n of the result it came from, and end with a "Sources" list: [n] [title](url), with the date checked.
- Never state a past conversation that is not in <memory>. If memory has nothing for the requested time, say you have no record of it and offer to look it up now.
- Things from <memory> or <user_profile> are not search results: no [n] and no Sources list for them. Give the date exactly as <memory> writes it, in a sentence; a table only for three or more items.
- <user_profile> holds what the user has told you about themselves, newest value per fact; trust it over older messages and never search the web for it. If <memory> shows an older, different value, the fact changed: say so when asked.
- When something has changed, lead with the change.
- Ask one clarifying question only when the request cannot be answered otherwise.`,
    thisTurn,
  ].join('\n\n');
}
