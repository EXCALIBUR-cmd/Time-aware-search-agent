'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { citedSources, withoutSourcesSection } from '@/lib/citations';
import { reportsAConfirmedChange } from '@/lib/verdict';

type Conversation = { id: string; title: string; created_at: string; is_demo: 0 | 1 };
type ServerClock = { now: string; demoDay: string | null; demoHistory: string | null };
type StoredSource ={ sourceId: string; title: string; url: string; official: boolean };
type Stored = { id: string; role: 'user' | 'assistant'; content: string; notice: string | null; sources: StoredSource[] };

const partsOf = (stored: Stored): UIMessage['parts'] => [
  { type: 'text', text: stored.content },
  ...stored.sources.map(({ sourceId, title, url, official }) => ({
    type: 'source-url' as const,
    sourceId,
    title,
    url,
    ...(official ? { providerMetadata: { agent: { sourceType: 'official' } } } : {}),
  })),
  ...(stored.notice ? [{ type: 'data-notice' as const, data: stored.notice }] : []),
];

const transport = new DefaultChatTransport({ api: '/api/chat' });
const DEV = process.env.NODE_ENV === 'development';
const CLOCK_KEY = 'simulatedNow';
const toDatetimeLocalValue = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const readRememberedClock = () => {
  try {
    return localStorage.getItem(CLOCK_KEY) ?? '';
  } catch {
    return '';
  }
};
const rememberClockIfStorageAllows = (value: string) => {
  try {
    if (value) localStorage.setItem(CLOCK_KEY, value);
    else localStorage.removeItem(CLOCK_KEY);
  } catch {
    return;
  }
};
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const ADDING_CITATIONS = 'Adding citations';
const CLOCK_HINT = 'Simulate a different ‘today’ to test time-based memory';
const EXAMPLE_QUESTIONS = [
  'What’s the latest Next.js version?',
  'Compare Postgres hosting prices for Neon, Supabase and Railway',
  'What did I ask you last Tuesday?',
  'Has any pricing changed since then?',
];
const VERDICT_LINE = /^\*\*([^*\n]+)\*\*[ \t]*\n/;
const CHANGED_CELL: Record<string, string> = {
  Yes: 'rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 dark:bg-amber-900/50 dark:text-amber-100',
  No: 'text-zinc-500 dark:text-zinc-400',
  Unknown: 'italic text-zinc-500 dark:text-zinc-400',
};
const cellText = (children: ReactNode) =>
  (Array.isArray(children) ? children.join('') : typeof children === 'string' ? children : '').trim();

function Message({ message, citing = false }: { message: UIMessage; citing?: boolean }) {
  const finalAnswer = message.parts.flatMap((p) => (p.type === 'data-final-answer' ? [String(p.data)] : []))[0];
  const text = finalAnswer ?? message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const sources = citedSources(
    text,
    message.parts.filter((p) => p.type === 'source-url'),
  );
  const notice = message.parts.flatMap((p) => (p.type === 'data-notice' ? [String(p.data)] : []))[0];
  const isReverification = text.includes('| Changed? |');
  const verdict = isReverification ? VERDICT_LINE.exec(text)?.[1] : undefined;
  const withoutVerdict = verdict ? text.replace(VERDICT_LINE, '') : text;
  const body = sources.length ? withoutSourcesSection(withoutVerdict) : withoutVerdict;
  const confirmedChange = verdict !== undefined && reportsAConfirmedChange(verdict);
  if (message.role === 'user') {
    return <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-100 px-4 py-2 dark:bg-zinc-800">{text}</div>;
  }
  return (
    <div className="space-y-3">
      <div
        key={finalAnswer === undefined ? 'draft' : 'final'}
        className={`md ${finalAnswer !== undefined ? 'fade-in' : citing ? 'opacity-50 transition-opacity duration-300' : ''}`}
      >
      {verdict && (
        <p
          className={`rounded-lg border px-3 py-2 text-sm font-medium ${confirmedChange ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200' : 'border-zinc-200 bg-zinc-50 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200'}`}
        >
          {verdict}
        </p>
      )}
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          table: ({ node: _node, ...props }) => (
            <div className="table-scroll">
              <table {...props} />
            </div>
          ),
          td: ({ node: _node, children, ...props }) => {
            const style = isReverification ? CHANGED_CELL[cellText(children)] : undefined;
            return <td {...props}>{style ? <span className={style}>{children}</span> : children}</td>;
          },
        }}
      >
        {body}
      </Markdown>
      </div>
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sources.map((s) => {
            const official = s.providerMetadata?.agent?.sourceType === 'official';
            return (
              <a
                key={s.sourceId}
                href={s.url}
                title={s.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Source ${s.sourceId}: ${host(s.url)}${official ? ', official' : ''} (opens in a new tab)`}
                className="inline-flex min-h-6 items-center gap-1.5 rounded-full border border-zinc-300 px-2.5 py-0.5 text-xs !no-underline hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500"
              >
                <span className="text-zinc-500 dark:text-zinc-400">{s.sourceId}</span>
                <span>{host(s.url)}</span>
                {official && (
                  <span className="rounded bg-emerald-50 px-1 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                    official
                  </span>
                )}
              </a>
            );
          })}
        </div>
      )}
      {notice && <p className="text-xs text-zinc-500 dark:text-zinc-400">{notice}</p>}
    </div>
  );
}

export default function Page() {
  const [chatId, setChatId] = useState(() => crypto.randomUUID());
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [statusLine, setStatusLine] = useState('');
  const [input, setInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, setMessages, status, error } = useChat({
    id: chatId,
    transport,
    onData: (part) => {
      if (part.type === 'data-status') setStatusLine(String(part.data));
    },
  });
  const busy = status === 'submitted' || status === 'streaming';
  const lastMessage = messages.at(-1);
  const answerStarted =
    lastMessage?.role === 'assistant' && lastMessage.parts.some((p) => p.type === 'text' && p.text.trim().length > 0);
  const showStatus = busy && statusLine !== '' && (!answerStarted || statusLine.startsWith(ADDING_CITATIONS));

  const [simulated, setSimulated] = useState('');
  const [realNow, setRealNow] = useState('');
  const [serverNow, setServerNow] = useState('');
  const [demoDay, setDemoDay] = useState<string | null>(null);
  const [demoHistory, setDemoHistory] = useState('');
  function loadServerClock() {
    setRealNow(toDatetimeLocalValue(new Date()));
    fetch('/api/clock')
      .then((r) => r.json())
      .then((clock: ServerClock) => {
        setServerNow(toDatetimeLocalValue(new Date(clock.now)));
        setDemoDay(clock.demoDay);
        setDemoHistory(clock.demoHistory ?? '');
      })
      .catch(() => {});
  }
  useEffect(() => {
    if (!DEV) return;
    loadServerClock();
    setSimulated(readRememberedClock());
  }, []);
  function setClock(value: string) {
    const isInThePast = value !== '' && value < toDatetimeLocalValue(new Date());
    const pastTimeOrRealTime = isInThePast ? value : '';
    setSimulated(pastTimeOrRealTime);
    rememberClockIfStorageAllows(pastTimeOrRealTime);
  }

  useEffect(() => {
    if (busy) return;
    fetch('/api/conversations')
      .then((r) => r.json())
      .then(setConversations)
      .catch(() => {});
  }, [busy]);

  useEffect(() => {
    fetch(`/api/conversations?id=${encodeURIComponent(chatId)}`)
      .then((r) => r.json())
      .then((rows: Stored[]) => {
        if (rows.length) setMessages(rows.map((m) => ({ id: m.id, role: m.role, parts: partsOf(m) })));
      })
      .catch(() => {});
  }, [chatId]);

  const scrollToBottomReturningNothing = (): void => {
    bottom.current?.scrollIntoView();
  };
  useEffect(scrollToBottomReturningNothing, [messages, statusLine]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [sidebarOpen]);

  function openChat(id: string) {
    setChatId(id);
    setSidebarOpen(false);
  }

  function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setStatusLine('');
    setInput('');
    void sendMessage({ text }, DEV && simulated ? { body: { now: new Date(simulated).toISOString() } } : undefined);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    ask(input);
  }

  return (
    <div className="flex h-dvh">
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close conversations"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 sm:hidden"
        />
      )}
      <aside
        id="conversations"
        className={`fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] shrink-0 flex-col border-r border-zinc-200 bg-white p-3 transition-transform duration-200 motion-reduce:transition-none sm:visible sm:static sm:z-auto sm:w-64 sm:translate-x-0 dark:border-zinc-800 dark:bg-zinc-950 ${sidebarOpen ? 'visible translate-x-0' : 'invisible -translate-x-full'}`}
      >
        <div className="flex gap-2">
          <button
            onClick={() => openChat(crypto.randomUUID())}
            className="min-h-10 flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-left text-sm font-medium hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            New chat
          </button>
          <button
            type="button"
            aria-label="Close conversations"
            onClick={() => setSidebarOpen(false)}
            className="inline-flex size-10 items-center justify-center rounded-lg hover:bg-zinc-100 sm:hidden dark:hover:bg-zinc-800"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5 fill-none stroke-current stroke-[1.5]">
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <nav aria-label="Conversations" className="mt-3 flex-1 space-y-1 overflow-y-auto">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => openChat(c.id)}
              aria-current={c.id === chatId}
              className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 dark:hover:bg-zinc-800 ${c.id === chatId ? 'bg-zinc-100 dark:bg-zinc-800' : ''}`}
            >
              <span className="block truncate">{c.title}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{day(c.created_at)}</span>
              {c.is_demo === 1 && (
                <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                  Demo
                </span>
              )}
            </button>
          ))}
        </nav>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 sm:px-4 dark:border-zinc-800">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Open conversations"
              aria-expanded={sidebarOpen}
              aria-controls="conversations"
              onClick={() => setSidebarOpen(true)}
              className="inline-flex size-10 items-center justify-center rounded-lg hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-zinc-500 sm:hidden dark:hover:bg-zinc-800"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5 fill-none stroke-current stroke-[1.5]">
                <path d="M3.5 6h13M3.5 10h13M3.5 14h13" strokeLinecap="round" />
              </svg>
            </button>
            <span className="text-sm font-semibold">Time-Aware Search Agent</span>
          </div>
          {DEV && (
            <label title={CLOCK_HINT} className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4 fill-none stroke-current stroke-[1.5]">
                <circle cx="10" cy="10" r="7.25" />
                <path d="M10 6v4l2.5 2" strokeLinecap="round" />
              </svg>
              <span className="hidden sm:inline">Today</span>
              <input
                type="datetime-local"
                value={simulated || serverNow}
                max={realNow}
                aria-describedby="clock-hint"
                onFocus={loadServerClock}
                onChange={(e) => setClock(e.target.value)}
                className={`h-9 w-44 rounded-md border bg-white px-2 text-sm text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-500 sm:w-auto dark:bg-zinc-900 dark:text-zinc-100 ${simulated ? 'border-amber-400 dark:border-amber-500' : 'border-zinc-300 dark:border-zinc-700'}`}
              />
              <span id="clock-hint" className="sr-only">
                {CLOCK_HINT}
              </span>
            </label>
          )}
        </header>
        {DEV && simulated && (
          <p
            role="status"
            className="flex flex-wrap items-center justify-center gap-x-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />
            <span>
              Simulated date:{' '}
              <strong className="font-semibold">
                {new Date(simulated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => setClock('')}
              className="inline-flex min-h-6 items-center font-medium underline underline-offset-2 hover:text-amber-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 dark:hover:text-amber-100 dark:focus-visible:outline-amber-400"
            >
              {demoDay ? 'Reset to demo clock' : 'Reset to real time'}
            </button>
          </p>
        )}
        {DEV && !simulated && demoDay && (
          <p
            role="status"
            className="flex flex-wrap items-center justify-center gap-x-2 border-b border-sky-200 bg-sky-50 px-4 py-1.5 text-center text-xs text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-200"
          >
            <span>
              Demo clock: <strong className="font-semibold">{demoDay}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Sample history from {demoHistory}. Run <code className="font-mono">npm run dev</code> for real time.
            </span>
          </p>
        )}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 p-4">
            {messages.length === 0 && (
              <section aria-labelledby="empty-title" className="pt-16 sm:pt-24">
                <h1 id="empty-title" className="text-lg font-semibold">
                  Search the web, with a memory
                </h1>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Answers current questions with cited sources, remembers what you discussed and when, and re-checks old answers against today’s web.
                </p>
                <ul className="mt-6 grid gap-2 sm:grid-cols-2">
                  {EXAMPLE_QUESTIONS.map((question) => (
                    <li key={question}>
                      <button
                        type="button"
                        onClick={() => ask(question)}
                        className="flex min-h-11 w-full items-center rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500"
                      >
                        {question}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {messages.map((m, i) => (
              <Message
                key={m.id}
                message={m}
                citing={busy && i === messages.length - 1 && statusLine.startsWith(ADDING_CITATIONS)}
              />
            ))}
            {showStatus && (
              <p role="status" aria-live="polite" className="flex min-w-0 items-center text-xs text-zinc-500 dark:text-zinc-400">
                <span className="truncate">{statusLine.replace(/(…|\.\.\.)$/, '')}</span>
                <span aria-hidden="true" className="status-dots">
                  <span>.</span>
                  <span>.</span>
                  <span>.</span>
                </span>
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                {error.message}
              </p>
            )}
            <div ref={bottom} />
          </div>
        </div>
        <form onSubmit={submit} className="mx-auto flex w-full max-w-3xl gap-2 p-3 sm:p-4">
          <input
            aria-label="Message"
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message"
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-400"
          />
          <button
            disabled={busy || !input.trim()}
            className="min-h-11 rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Send
          </button>
        </form>
      </main>
    </div>
  );
}
