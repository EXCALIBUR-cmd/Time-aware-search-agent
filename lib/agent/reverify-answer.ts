import { groq } from '@ai-sdk/groq';
import { generateText } from 'ai';
import { FAST_MODEL_PROVIDER_OPTIONS } from '../config';
import type { NumberedResult } from '../search/web-search-tool';
import { joinSections } from './answer';
import { errorMessage, logActualUsage, logPromptSize } from './budget';
import { callWithFallback, SMALLER_MODEL_NOTICE, type ChunkSink, type ModelPair } from './fallback';
import {
  atMostTwoSentences,
  checkRows,
  EXTRACTION_SYSTEM,
  extractionPrompt,
  parseExtraction,
  renderSources,
  renderTable,
  renderVerdict,
  type CheckedRow,
  type ClaimRow,
  type ExtractedValue,
} from './reverify';

const CONTEXT_SYSTEM = `You are given a verified table of re-checked prices. Write at most 2 sentences of context about the rows marked Yes only, using the quotes given. Do not repeat the table, do not add a heading or a list, and never state a value that is not in the table.`;

export type Reverification = { markdown: string; modelId: string; rows: CheckedRow[] };

async function ask(modelId: string, isFastModel: boolean, system: string, prompt: string, callName: string) {
  const estimated = logPromptSize(callName, [system, prompt]);
  const { text, usage } = await generateText({
    model: groq(modelId),
    providerOptions: isFastModel ? FAST_MODEL_PROVIDER_OPTIONS : undefined,
    system,
    prompt,
    temperature: 0,
    maxRetries: 0,
  });
  logActualUsage(callName, estimated, usage.inputTokens);
  return text;
}

function parsedOrNothing(modelOutput: string): ExtractedValue[] {
  try {
    return parseExtraction(modelOutput);
  } catch (error) {
    console.error('[agent] value extraction returned unusable JSON:', errorMessage(error));
    return [];
  }
}

function writeMarkdown(sink: ChunkSink, markdown: string): void {
  const id = 'reverification';
  sink.write({ type: 'start' });
  sink.write({ type: 'text-start', id });
  sink.write({ type: 'text-delta', id, delta: markdown });
  sink.write({ type: 'text-end', id });
}

export async function answerReverification(
  input: { rows: ClaimRow[]; sources: NumberedResult[]; since: string; tz: string; models: ModelPair },
  sink: ChunkSink,
  status: (text: string) => void,
): Promise<Reverification> {
  status(`Checking ${input.rows.length} claims against their sources…`);
  const prompt = extractionPrompt(input.rows, input.sources);
  const extraction = await callWithFallback(
    (modelId, isFastModel) => ask(modelId, isFastModel, EXTRACTION_SYSTEM, prompt, `${modelId} value extraction`),
    input.models,
    status,
  );
  const rows = checkRows(input.rows, parsedOrNothing(extraction.result), input.sources);
  const table = renderTable(rows, input.tz);
  const changedRows = rows.filter((row) => row.changed === 'yes');
  const quotes = changedRows.map((row) => `${row.subject} · ${row.attribute}: "${row.quote}"`).join('\n');
  const models = { main: extraction.modelId, fast: input.models.fast };
  const context = changedRows.length
    ? await callWithFallback(
        (modelId, isFastModel) => ask(modelId, isFastModel, CONTEXT_SYSTEM, `${table}\n\nQuotes:\n${quotes}`, `${modelId} change context`),
        models,
        status,
      )
        .then((answer) => atMostTwoSentences(answer.result))
        .catch(() => '')
    : '';
  const markdown = joinSections([renderVerdict(rows, input.since), table, context, renderSources(rows)]);
  writeMarkdown(sink, markdown);
  if (extraction.usedFastModel) sink.write({ type: 'data-notice', data: SMALLER_MODEL_NOTICE });
  return { markdown, modelId: extraction.modelId, rows };
}
