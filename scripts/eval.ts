import { randomUUID } from 'node:crypto';
import { runAgent } from '../lib/agent/run';
import { DEMO_NOW } from './seed';

try {
  process.loadEnvFile();
} catch {}

process.env.AGENT_NOW = DEMO_NOW;

type Run = { text: string; statuses: string[]; firstStatusMs: number; firstTokenMs: number };
type Scenario = { name: string; ask: string; chat?: string; check: (r: Run) => boolean };

const cited = (r: Run) => /\[\d+\]/.test(r.text) && /https?:\/\//.test(r.text);
const hasTable = (r: Run) => /\|.+\|/.test(r.text);
const searched = (r: Run) => r.statuses.some((s) => s.startsWith('Searching'));
const noRecord = (r: Run) => /no record|no conversation|don[’']t have|do not have|couldn[’']t find|nothing/i.test(r.text);

const pgChat = randomUUID();
const scenarios: Scenario[] = [
  { name: 'CRM shortlist re-check', ask: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?', check: (r) => hasTable(r) && cited(r) },
  { name: '3 Nov recall + re-check', ask: 'What did I ask you on 3 November? Is your answer still correct today?', check: (r) => /postgres/i.test(r.text) && cited(r) },
  { name: 'Postgres pricing table', chat: pgChat, ask: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', check: (r) => hasTable(r) && cited(r) },
  { name: 'Follow-up in same chat', chat: pgChat, ask: 'And which of those is cheapest?', check: (r) => r.text.length > 0 },
  { name: 'No memory: honest', ask: 'What did I ask you on 1 October?', check: (r) => noRecord(r) && !searched(r) },
  { name: 'Plain current question', ask: "What's the latest Next.js version?", check: (r) => searched(r) && cited(r) },
  { name: 'Small talk: no search', ask: 'Thanks!', check: (r) => r.text.length > 0 && !searched(r) },
  { name: 'Ambiguous date', ask: 'What did we discuss last week?', check: (r) => /Nov/.test(r.text) && !searched(r) },
];

async function run(s: Scenario): Promise<Run> {
  const r: Run = { text: '', statuses: [], firstStatusMs: -1, firstTokenMs: -1 };
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const reader = runAgent({ conversationId: s.chat ?? randomUUID(), text: s.ask }).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return r;
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
  const rows: Record<string, string | number>[] = [];
  for (const s of scenarios) {
  const r = await run(s).catch((e: unknown): Run => ({ text: `ERROR: ${String(e)}`, statuses: [], firstStatusMs: -1, firstTokenMs: -1 }));
  const pass = !r.text.includes('ERROR:') && s.check(r);
  rows.push({ scenario: s.name, result: pass ? 'PASS' : 'FAIL', 'first status (ms)': r.firstStatusMs, 'first token (ms)': r.firstTokenMs });
  if (!pass) console.log(`\n--- ${s.name} failed ---\n${r.statuses.join('\n')}\n${r.text}\n`);
}
console.table(rows);
  process.exitCode = rows.some((r) => r.result === 'FAIL') ? 1 : 0;
}
void main();
