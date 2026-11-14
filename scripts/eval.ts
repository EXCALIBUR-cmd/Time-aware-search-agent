import { randomUUID } from 'node:crypto';
import { runAgent } from '../lib/agent/run';
import { getConfig } from '../lib/config';
import { DEMO_NOW } from './seed';

function loadEnvFileIfPresent(): void {
  try {
    process.loadEnvFile();
  } catch {
    return;
  }
}
loadEnvFileIfPresent();

process.env.AGENT_NOW = DEMO_NOW;

const MINUTE_MS = 60_000;
const TOKENS_PER_MINUTE_PER_MODEL = 8000;
const SHARE_FOR_LOGGED_INPUT_TOKENS = 0.75;
const FIRST_GUESS_PER_SCENARIO = 3000;
const PLANNED_TOKENS_PER_MINUTE = TOKENS_PER_MINUTE_PER_MODEL * SHARE_FOR_LOGGED_INPUT_TOKENS;

type Usage = { model: string; at: number; tokens: number };
const usage: Usage[] = [];
const largestScenarioUse = new Map<string, number>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recordUsageLines(fastModel: string): void {
  console.info = (...args: unknown[]) => {
    const logged = /^\[usage\] (.+?): estimated \d+, Groq counted (\d+)/.exec(args.join(' '));
    if (!logged) return;
    const callModel = logged[1].split(' ')[0];
    usage.push({ model: callModel.includes('/') ? callModel : fastModel, at: Date.now(), tokens: Number(logged[2]) });
  };
}

function waitNeededFor(model: string, now: number): number {
  const recent = usage.filter((u) => u.model === model && now - u.at < MINUTE_MS).sort((a, b) => a.at - b.at);
  const need = largestScenarioUse.get(model) ?? FIRST_GUESS_PER_SCENARIO;
  let used = recent.reduce((sum, u) => sum + u.tokens, 0);
  for (const oldest of recent) {
    if (used + need <= PLANNED_TOKENS_PER_MINUTE) break;
    used -= oldest.tokens;
    if (used + need <= PLANNED_TOKENS_PER_MINUTE) return oldest.at + MINUTE_MS - now;
  }
  return 0;
}

async function waitForHeadroom(models: string[]): Promise<number> {
  const wait = Math.max(0, ...models.map((model) => waitNeededFor(model, Date.now())));
  await sleep(wait);
  return wait;
}

function rememberScenarioUse(since: number): void {
  const used = new Map<string, number>();
  for (const u of usage.filter((entry) => entry.at >= since)) used.set(u.model, (used.get(u.model) ?? 0) + u.tokens);
  for (const [model, tokens] of used) largestScenarioUse.set(model, Math.max(tokens, largestScenarioUse.get(model) ?? 0));
}

const retryWaitSeconds = (statuses: string[]) =>
  statuses.reduce((sum, status) => sum + Number(/retrying in (\d+) s/.exec(status)?.[1] ?? 0), 0);

type Run = { text: string; statuses: string[]; firstStatusMs: number; firstTokenMs: number };
type Scenario = { name: string; ask: string; chat?: string; check: (r: Run) => string[] };

const SOURCES_SECTION = /\n\**\s*sources[\s\S]*$/i;
const failures = (...checks: [boolean, string][]) => checks.filter(([ok]) => !ok).map(([, reason]) => reason);
const citations = (r: Run): [boolean, string][] => [
  [/\[\d+\]/.test(r.text.replace(SOURCES_SECTION, '')), 'search was used but the answer has no inline [n] citation'],
  [/https?:\/\//.test(r.text), 'the answer links no source URL'],
];
const hasTable = (r: Run) => /\|.+\|/.test(r.text);
const searched = (r: Run) => r.statuses.some((s) => s.startsWith('Searching') || s.startsWith('Checking official pages'));
const noRecord = (r: Run) => /no record|no conversation|don[’']t have|do not have|couldn[’']t find|nothing/i.test(r.text);

const pgChat = randomUUID();
const scenarios: Scenario[] = [
  {
    name: 'CRM shortlist re-check',
    ask: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    check: (r) => failures([hasTable(r), 'no table'], ...citations(r)),
  },
  {
    name: '3 Nov recall + re-check',
    ask: 'What did I ask you on 3 November? Is your answer still correct today?',
    check: (r) => failures([/postgres/i.test(r.text), 'does not mention Postgres'], ...citations(r)),
  },
  {
    name: 'Postgres pricing table',
    chat: pgChat,
    ask: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    check: (r) => failures([hasTable(r), 'no table'], ...citations(r)),
  },
  { name: 'Follow-up in same chat', chat: pgChat, ask: 'And which of those is cheapest?', check: (r) => failures([r.text.length > 0, 'empty answer']) },
  {
    name: 'No memory: honest',
    ask: 'What did I ask you on 1 October?',
    check: (r) => failures([noRecord(r), 'does not say there is no record'], [!searched(r), 'searched the web']),
  },
  {
    name: 'Plain current question',
    ask: "What's the latest Next.js version?",
    check: (r) => failures([searched(r), 'did not search'], ...citations(r)),
  },
  {
    name: 'Small talk: no search',
    ask: 'Thanks!',
    check: (r) => failures([r.text.length > 0, 'empty answer'], [!searched(r), 'searched the web']),
  },
  {
    name: 'Ambiguous date',
    ask: 'What did we discuss last week?',
    check: (r) => failures([/Nov/.test(r.text), 'names no November date'], [!searched(r), 'searched the web']),
  },
];

async function run(s: Scenario): Promise<Run> {
  const r: Run = { text: '', statuses: [], firstStatusMs: -1, firstTokenMs: -1 };
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const reader = runAgent({ conversationId: s.chat ?? randomUUID(), text: s.ask }).getReader();
  let finalAnswer: string | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return finalAnswer === undefined ? r : { ...r, text: finalAnswer };
    if (value.type === 'data-final-answer') finalAnswer = String(value.data);
    if (value.type === 'data-status') {
      if (r.firstStatusMs < 0) r.firstStatusMs = ms();
      r.statuses.push(String(value.data));
    } else if (value.type === 'text-delta') {
      if (r.firstTokenMs < 0) r.firstTokenMs = ms();
      r.text += value.delta;
    } else if (value.type === 'error') {
      r.text += `\nERROR: ${value.errorText}`;
    }
  }
}

async function main() {
  const { MAIN_MODEL, FAST_MODEL } = getConfig();
  recordUsageLines(FAST_MODEL);
  const started = performance.now();
  let pacedMs = 0;
  const rows: Record<string, string | number>[] = [];
  for (const s of scenarios) {
    const paced = await waitForHeadroom([MAIN_MODEL, FAST_MODEL]);
    pacedMs += paced;
    const scenarioStart = Date.now();
    const r = await run(s).catch((e: unknown): Run => ({ text: `ERROR: ${String(e)}`, statuses: [], firstStatusMs: -1, firstTokenMs: -1 }));
    rememberScenarioUse(scenarioStart);
    const error = r.text.indexOf('ERROR:');
    const reasons = error === -1 ? s.check(r) : [r.text.slice(error, error + 120)];
    const pass = reasons.length === 0;
    rows.push({
      scenario: s.name,
      result: pass ? 'PASS' : 'FAIL',
      'first status (ms)': r.firstStatusMs,
      'first token (ms)': r.firstTokenMs,
      'paced before (s)': Math.round(paced / 1000),
      'rate-limit retry (s)': retryWaitSeconds(r.statuses),
      'small model': r.statuses.some((status) => status.includes('answering with the smaller model')) ? 'yes' : '',
      why: reasons.join('; '),
    });
    if (!pass) console.log(`\n--- ${s.name} failed: ${reasons.join('; ')} ---\n${r.statuses.join('\n')}\n${r.text}\n`);
  }
  console.table(rows);
  const totalSeconds = Math.round((performance.now() - started) / 1000);
  console.log(`Total ${totalSeconds} s, of which ${Math.round(pacedMs / 1000)} s pacing between scenarios to stay under ${TOKENS_PER_MINUTE_PER_MODEL} tokens per minute per model.`);
  process.exitCode = rows.some((r) => r.result === 'FAIL') ? 1 : 0;
}
void main();
