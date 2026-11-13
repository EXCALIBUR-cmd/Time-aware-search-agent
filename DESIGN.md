# Design

## How it works

One pipeline per turn. Three steps call a model: router, answer, extraction.

```
resolve dates in code    "last Tuesday" → 3 Nov, full day, IST
recall from SQLite       profile, dated messages, FTS5 topic matches, claims
route and plan (small)   chat/fresh/recall/reverify, 1 to 4 queries
search in code           in parallel, at most 8 results
answer (main model)      one call; one follow-up search
stream                   status, tokens, source chips
afterwards               save, extract claims and facts, index
```

- Chat and recall skip search; recall runs every turn.
- Nothing after the last token makes the user wait.
- Server history is the source of truth; the client sends only the new message.

## Why this way

Every question in the brief is about time, so memory is the product; search is table stakes.

- **Dated memory with claims.** Answers are kept as text and as claim rows (subject, attribute, value, source, date checked). Re-verification compares them with fresh results (was / now / changed) and adds rows, never overwrites.
- **Date maths in code.** Every `<memory>` item carries its date; an empty range is stated, which stops invented memories. A date without a year is its most recent occurrence.
- **Rules outrank the router.** A past date or "do you remember" forces memory mode.
- **User profile.** Stated facts (name, role, location, preferences) are append-only, injected every turn; newest wins.
- **Recall respects the clock.** Only rows dated up to the agent's "now" are readable, ranges are clamped to it, nothing is deleted. Web search and its cache use the real clock.
- **One tool, planned searches.** Memory is a pipeline step. The router plans queries, so the main model usually answers in one call: 9,481 → 5,148 prompt tokens over three questions (46% fewer), first token 7.3 s → 2.3 s. The open chat is not recalled: it is the history.
- **Token budget.** About 6,000 tokens (instructions and profile 800, memory 1,200, search 3,000, history 1,000); lowest-ranked results drop first, then older turns. Counted with o200k plus 74 per request and 116 for the tool: exact against Groq on first steps (506 vs 506), 5 to 7% high after a follow-up search.
- **Rate limits.** On a 429, retry only if Groq asks for 5 s or less; otherwise the small model answers with a note. The answering model is stored, so the note survives a reload.
- **Search cache.** 6 h; 30 min for prices and news; bypassed when re-verifying.

## Considered and rejected

- **Vector database.** Built one in Nova Chat; embeddings do not understand "3 November".
- **LangChain.** Hides the decisions this exercise is about.
- **Multi-agent planner.** Too slow for a chat turn.
- **LLM date maths.** Unreliable; trivially correct in code.
- **A memory tool.** A round trip for what the message already says.

## Trade-offs

- FTS5 misses synonyms.
- The router can misclassify; failure or its 1.5 s timeout falls back to a fresh search. Over 10 turns: median 0.5 s, 90th percentile 1.2 s.
- "Last Tuesday" is the most recent Tuesday; "Monday" on a Monday recalls today and a week ago.
- Free-tier caps: 50 messages per range, 8 topic matches, 3 results per query.
- A user fact needs its value word for word; claim extraction sees titles and URLs, not page text.
- A follow-up search costs more: about 6,500 tokens in one run.

## With another week

Hybrid FTS and embeddings; fetching pricing pages; per-user auth; Turso; scheduled re-checks with notifications; a larger graded eval set.
