'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { citedSources } from '@/lib/citations';

type Conversation = { id: string; title: string; created_at: string; is_demo: 0 | 1 };
type Stored = { id: string; role: 'user' | 'assistant'; content: string; notice: string | null };

const partsOf = (stored: Stored): UIMessage['parts'] => [
  { type: 'text', text: stored.content },
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

function Message({ message, citing = false }: { message: UIMessage; citing?: boolean }) {
  const finalAnswer = message.parts.flatMap((p) => (p.type === 'data-final-answer' ? [String(p.data)] : []))[0];
  const text = finalAnswer ?? message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const sources = citedSources(
    text,
    message.parts.filter((p) => p.type === 'source-url'),
  );
  const notice = message.parts.flatMap((p) => (p.type === 'data-notice' ? [String(p.data)] : []))[0];
  if (message.role === 'user') {
    return <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-100 px-4 py-2">{text}</div>;
  }
  return (
    <div className="md">
      <div
        key={finalAnswer === undefined ? 'draft' : 'final'}
        className={finalAnswer !== undefined ? 'fade-in' : citing ? 'opacity-50 transition-opacity duration-300' : ''}
      >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {text}
      </Markdown>
      </div>
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sources.map((s) => (
            <a
              key={s.sourceId}
              href={s.url}
              title={s.title}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs !no-underline hover:bg-zinc-100"
            >
              [{s.sourceId}] {host(s.url)}
            </a>
          ))}
        </div>
      )}
      {notice && <p className="text-xs text-zinc-500">{notice}</p>}
    </div>
  );
}

export default function Page() {
  const [chatId, setChatId] = useState(() => crypto.randomUUID());
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [statusLine, setStatusLine] = useState('');
  const [input, setInput] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, setMessages, status, error } = useChat({
    id: chatId,
    transport,
    onData: (part) => {
      if (part.type === 'data-status') setStatusLine(String(part.data));
    },
  });
  const busy = status === 'submitted' || status === 'streaming';

  const [simulated, setSimulated] = useState('');
  const [realNow, setRealNow] = useState('');
  useEffect(() => {
    if (!DEV) return;
    setRealNow(toDatetimeLocalValue(new Date()));
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

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setStatusLine('');
    setInput('');
    void sendMessage({ text }, DEV && simulated ? { body: { now: new Date(simulated).toISOString() } } : undefined);
  }

  return (
    <div className="flex h-dvh">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-zinc-200 p-3 sm:flex">
        <button
          onClick={() => setChatId(crypto.randomUUID())}
          className="rounded-lg border border-zinc-300 px-3 py-2 text-left text-sm font-medium hover:bg-zinc-100"
        >
          New chat
        </button>
        <nav aria-label="Conversations" className="mt-3 flex-1 space-y-1 overflow-y-auto">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setChatId(c.id)}
              aria-current={c.id === chatId}
              className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 ${c.id === chatId ? 'bg-zinc-100' : ''}`}
            >
              <span className="block truncate">{c.title}</span>
              <span className="text-xs text-zinc-500">{day(c.created_at)}</span>
              {c.is_demo === 1 && (
                <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                  Demo
                </span>
              )}
            </button>
          ))}
        </nav>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {DEV && (
          <header className="flex justify-end border-b border-zinc-200 px-4 py-2">
            <label className="flex items-center gap-2 text-sm text-zinc-600">
              Today
              <input
                type="datetime-local"
                value={simulated || realNow}
                max={realNow}
                onFocus={() => setRealNow(toDatetimeLocalValue(new Date()))}
                onChange={(e) => setClock(e.target.value)}
                className="rounded border border-zinc-300 px-2 py-1 text-zinc-900"
              />
            </label>
          </header>
        )}
        {DEV && simulated && (
          <p role="status" className="bg-amber-100 px-4 py-1 text-center text-xs text-amber-900">
            Simulated date: {new Date(simulated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
            <button type="button" onClick={() => setClock('')} className="underline">
              Reset to real time
            </button>
          </p>
        )}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 p-4">
            {messages.length === 0 && (
              <p className="pt-24 text-center text-zinc-500">Ask something current, or about a past conversation.</p>
            )}
            {messages.map((m, i) => (
              <Message
                key={m.id}
                message={m}
                citing={busy && i === messages.length - 1 && statusLine.startsWith(ADDING_CITATIONS)}
              />
            ))}
            {busy && statusLine && (
              <p role="status" className="animate-pulse text-sm text-zinc-500">
                {statusLine}
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                {error.message}
              </p>
            )}
            <div ref={bottom} />
          </div>
        </div>
        <form onSubmit={submit} className="mx-auto flex w-full max-w-3xl gap-2 p-4">
          <input
            aria-label="Message"
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message"
            className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-zinc-500"
          />
          <button
            disabled={busy || !input.trim()}
            className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </main>
    </div>
  );
}
