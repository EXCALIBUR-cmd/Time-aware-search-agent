# minimi Chat Agent

A chat agent with one tool, web search, that remembers what it said and when, and can re-check its past answers against today's web. The design is argued in [DESIGN.md](DESIGN.md).

## Setup

Needs Node.js 20 or newer.

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `GROQ_API_KEY` and `TAVILY_API_KEY`.
3. `npm run dev`, then open http://localhost:3000.

`npm run dev` uses `data/agent.db`, which starts empty and only ever holds your own conversations.

## Try the memory features

Memory questions need a past, so the repo ships one. Instead of `npm run dev`, run:

```
npm run demo
```

This does two things, the same way on any OS:

- It writes three past conversations into a separate database, `data/demo.db`: a CRM shortlist (Mon 2 Nov 2026), Postgres hosting prices (Tue 3 Nov) and the Next.js version (Fri 6 Nov), each with its claims and sources. They carry a "Demo" tag in the sidebar. Your own `data/agent.db` is never touched.
- It starts the app on that database with the clock fixed to Monday 9 November 2026, 10:00 IST (`AGENT_NOW=2026-11-09T10:00:00+05:30`), so "last Tuesday" is 3 Nov and "last week" is 2 to 8 Nov.

Then ask, each in a new chat:

| Ask | What you should see |
|---|---|
| "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?" | The five tools recalled from 2 Nov, searched again, and a Then / Now / Changed? table |
| "What did I ask you on 3 November? Is your answer still correct today?" | The Postgres question and its answer, with each price re-checked |
| "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" | A was / now / changed table with sources |
| "What did we discuss last week?" | The three conversations, with their dates |
| "What did I ask you on 1 October?" | No record, said plainly, with an offer to look it up now. Nothing invented |

Things to know:

- Chats you have in the demo are saved in `data/demo.db` and survive a restart. Running `npm run demo` again resets only the three tagged conversations.
- The demo clock is a Monday, so "Monday" can mean 2 Nov or the demo's today; the agent recalls both and shows the dates.
- To go back to the real clock and your own history, stop the demo and run `npm run dev`.
- In dev mode the header has a "Today" control. Pick any past date and time and the agent treats it as now for date phrases, the prompt and the timestamps of new messages; web search still reads today's web. It is remembered in the browser, wins over `AGENT_NOW`, and a banner offers "Reset to real time".

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts the app on `data/agent.db` with the real clock |
| `npm run demo` | Seeds `data/demo.db` and starts the app on it with the clock fixed to 9 Nov 2026 |
| `npm test` | Unit tests for date resolution and memory |
| `npm run seed` | Only writes the demo history into `data/demo.db` (`demo` and `eval` already do this) |
| `npm run eval` | Replays 8 scenarios against the agent on `data/demo.db` and prints a pass/fail table with time to first token. Needs both keys |

## Where things are

The agent is plain TypeScript in `lib/`; Next.js is only the shell around it.

- `lib/time` turns "last Tuesday" into an exact date range, in code.
- `lib/memory` is the SQLite store: messages, claims with sources, facts about the user, keyword search, and the `<memory>` and `<user_profile>` prompt blocks.
- `lib/search` is the Tavily client and the single `web_search` tool (parallel queries, cache).
- `lib/agent` is the router, the system prompt and the streaming loop.
- `data/` holds the databases. They are created on first use and are not committed.

Built with Claude as a coding assistant; I can walk through any part of it.
