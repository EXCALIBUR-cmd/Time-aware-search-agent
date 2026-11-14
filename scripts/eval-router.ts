import { route } from '../lib/agent/router';
import { ROUTING_CASES } from '../lib/agent/routing-cases';

function loadEnvFileIfPresent(): void {
  try {
    process.loadEnvFile();
  } catch {
    return;
  }
}
loadEnvFileIfPresent();

const PAUSE_BETWEEN_CALLS_MS = 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (sorted: number[], share: number) => sorted[Math.ceil(share * sorted.length) - 1];

async function main() {
  console.info = () => undefined;
  const rows: Record<string, string | number>[] = [];
  const latencies: number[] = [];
  for (const routingCase of ROUTING_CASES) {
    const started = performance.now();
    const { mode, queries } = await route(routingCase.text, routingCase.hasPastDate, routingCase);
    const ms = Math.round(performance.now() - started);
    latencies.push(ms);
    rows.push({
      message: routingCase.text.slice(0, 48),
      expected: routingCase.expected,
      routed: mode,
      result: mode === routingCase.expected ? 'ok' : 'WRONG',
      queries: queries.length,
      ms,
    });
    await sleep(PAUSE_BETWEEN_CALLS_MS);
  }
  console.table(rows);
  const correct = rows.filter((row) => row.result === 'ok').length;
  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(
    `${correct}/${rows.length} routed as labelled | median ${percentile(sorted, 0.5)} ms | 90th percentile ${percentile(sorted, 0.9)} ms | slowest ${sorted.at(-1)} ms`,
  );
  process.exitCode = correct === rows.length ? 0 : 1;
}
void main();
