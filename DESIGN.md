# Design

## How it works

Every turn runs the same pipeline. Only three steps call a model: the router, the agent loop and extraction.

```
user message
  → resolve dates in code      "last Tuesday" → 3 Nov 00:00 to 23:59 IST   (chrono-node)
  → route (small model)        chat | fresh | recall | reverify; a past date or "do you remember" forces memory
  → recall from SQLite         user profile, every message in the date range, FTS5 topic matches, with their claims
  → agent loop (main model)    one tool, web_search: up to 4 parallel queries, at most 3 tool steps
  → stream the answer          status lines first, then tokens, then source chips
  → after the stream closes    save the answer, extract claims and user facts (small model), index them
```

Chat and recall turns skip search. The memory lookup is local SQLite, so it runs on every turn. Nothing after the last token makes the user wait. The server's stored history is the source of truth: the client sends only the new message.

## Why this way

Every question in the brief is about time: what was said on a date, and whether it is still true. So memory is the product and search is table stakes.

- **Memory is timestamped and stores claims.** An answer is kept as text and as rows of subject, attribute, value, source and date checked. Re-verification compares those rows with fresh evidence in a was / now / changed table. A re-check adds rows and keeps the old ones.
- **Date maths runs in code.** The model never works out what "Monday" means. It gets a `<memory>` block where every item carries its date, or an explicit "No conversations found between 1 Oct and 1 Oct", the line that stops invented memories. Phrases resolve to the past: a date without a year is its most recent occurrence, never a future one.
- **A user profile.** Facts the user states about themselves (name, role, location, preferences) are stored append-only and injected every turn, the newest value winning; dated messages still show what it was before.
- **Recall respects the clock.** Messages, claims and user facts are readable only when dated at or before the agent's "now", and date ranges are clamped to it: with the clock at 3 Nov, a chat from 8 Nov does not exist yet. Nothing is deleted; only recall is filtered. Web search and its cache always use the real clock.
- **One tool.** Memory needs are predictable from the message, so memory is a pipeline step, not a tool. The model has one decision: search or not. The open chat is left out of recall because it is already the model's history.
- **Speed comes from skipping work**: a small-model router (about half a second), no search for small talk or recall, parallel queries, a search cache (6 hours; 30 minutes for prices and news; bypassed when re-verifying).

## Considered and rejected

- **Vector database.** I built one in Nova Chat. Embeddings do not understand "3 November"; a date range and a keyword index do.
- **LangChain.** It hides the decisions this exercise is about.
- **Multi-agent planner.** Too slow for a chat turn.
- **LLM date maths.** Unreliable, and trivially correct in code.
- **A memory tool for the model.** It adds a round trip for something the message already tells us.

## Trade-offs

- FTS5 is keyword search: it misses synonyms.
- The router can misclassify. A past date overrides it, and a failure or a 1.5 s timeout falls back to a fresh search.
- "Last Tuesday" is read as the most recent Tuesday. "Monday" said on a Monday recalls both today and a week ago, since either could be meant.
- A date range is cut at 50 messages, topic matches at 8 and search at 3 results per query, to keep prompts inside free-tier token limits.
- A user fact is stored only when its value appears word for word in the message, so a paraphrase can be missed. Claim extraction sees source titles and URLs, not page text.
- Free tiers of Groq and Tavily limit heavy use; `MAIN_MODEL` and `FAST_MODEL` can be switched in `.env`.

## With another week

Hybrid FTS and embeddings; fetching pricing pages directly; per-user memory and auth; Turso for deployment; scheduled background re-checks that notify on changes; a larger eval set with graded answers.
