# Design

## How it works

One pipeline per turn. Three steps call a model: router, answer, extraction.

```
user message
  → resolve dates in code    "last Tuesday" = 3 Nov, IST
  → recall from SQLite       profile, dated messages, FTS5 matches, claims
  → route and plan (small)   chat/fresh/recall/reverify, 1 to 4 queries
  → search in code           in parallel, at most 8 results
  → answer (main model)      one call; one follow-up search
  → stream                   status, tokens, source chips
  → afterwards               save, extract claims and facts, index
```

- Chat and recall skip search; recall runs every turn.
- Nothing after the last token makes the user wait.
- Server history is the source of truth; the client sends only the new message.

## Why this way

Every question in the brief is about time: memory is the product, search table stakes.

- **Dated memory with claims.** Answers are kept as text and claim rows (subject, attribute, value, source, date checked). Re-verification compares them with fresh results (was / now / changed), adding rows, never overwriting.
- **Plan changes are changes.** When an official page shows a plan or fixed price is gone (now usage-based, say), extraction returns `plan_changed` with a quote that code checks like any value; the row reads "No longer offered" and counts as changed. It is not saved as a new claim: there is no value to compare next time.
- **Date maths in code.** Every `<memory>` item carries its date; an empty range is stated, which stops invented memories. A date without a year is its most recent occurrence.
- **Date and topic must both match.** "Last Tuesday … Postgres" recalls only conversations inside the range that mention the topic there; a whole conversation counts, since answers often drop the user's word. If none match, memory names the nearest on-topic date and the turn does not re-verify it.
- **Rules outrank the router.** A past date or "do you remember" forces memory; reverify needs the message to ask what changed. Labelled routing: 15/18 → 18/18.
- **User profile.** Stated facts (name, role, location, preferences) are append-only, injected every turn; newest wins.
- **Recall respects the clock.** Only rows dated up to the agent's "now" are readable and ranges stop there; nothing is deleted. Search and its cache use the real clock.
- **One tool, planned searches.** Memory is a pipeline step. The router plans queries, so the main model usually answers in one call: 9,481 → 5,148 prompt tokens over three questions (46% fewer), first token 7.3 s → 2.3 s. The open chat is not recalled: it is the history.
- **Token budget.** About 6,000 tokens (instructions and profile 800, memory 1,200, search 3,000, history 1,000); lowest-ranked results drop first, then older turns. Counted with o200k plus 74 per request and 116 for the tool: exact against Groq on first steps (506 vs 506), 5 to 7% high after a follow-up search.
- **Rate limits.** On a 429, retry only if Groq asks for 5 s or less; otherwise the small model answers with a note. The answering model is stored, so the note survives a reload.
- **Search cache.** 6 h; 30 min for prices and news; bypassed when re-verifying.

## Considered and rejected

- **Vector database.** Built one in Nova Chat; embeddings do not understand "3 November".
- **LangChain.** Hides the decisions.
- **Multi-agent planner.** Too slow for a chat turn.
- **LLM date maths.** Unreliable; trivially correct in code.
- **A memory tool.** A round trip for what the message already says.

## Trade-offs

- FTS5 misses synonyms.
- The router can misclassify; failure or its 2 s timeout means a fresh search. Median 0.5 s, 90th percentile 0.8 s, up to 1.8 s after idling.
- "Last Tuesday" is the most recent Tuesday; "Monday" on a Monday recalls today and a week ago.
- Free-tier caps: 50 messages per range, 8 topic matches, 3 results per query.
- A user fact needs its value word for word; claim extraction sees titles and URLs, not page text.
- A follow-up search costs more (about 6,500 tokens).

## With another week

Hybrid FTS and embeddings; fetching pricing pages; per-user auth; Turso; scheduled re-checks with notifications; a larger graded eval set.
