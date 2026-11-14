import type { UIMessageChunk } from 'ai';
import { errorMessage, isRateLimited, userFacingError } from './budget';

export const SMALLER_MODEL_NOTICE = 'Answered with a smaller model due to rate limits.';
export const LONGEST_WAIT_WORTH_RETRYING_MS = 5000;

export const noticeForAnswerBy = (answeredByModel: string | null, mainModel: string): string | null =>
  answeredByModel !== null && answeredByModel !== mainModel ? SMALLER_MODEL_NOTICE : null;

const SEARCHED_WHEN_NOT_ALLOWED = /tool choice is none|called a tool|not in request\.tools|tool_use_failed|failed to call a function/i;
const WAIT_STATED_IN_MESSAGE = /try again in (?:(\d+)m(?!s))?(?:([\d.]+)(ms|s))?/i;

export type HandOverReason = 'rate-limited' | 'searched-when-not-allowed';
export type AnswerOutcome = { reason?: HandOverReason; retryAfterMs?: number };
export type AnswerStream = {
  toUIMessageStream: (options: {
    sendReasoning: boolean;
    sendStart: boolean;
    onError: (error: unknown) => string;
  }) => ReadableStream<UIMessageChunk>;
};
export type ChunkSink = { write: (chunk: UIMessageChunk) => void };

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === 'object' && value !== null && field in value ? (value as Record<string, unknown>)[field] : undefined;

function waitFromHeaders(error: unknown): number | undefined {
  const headers = fieldOf(error, 'responseHeaders');
  const milliseconds = Number(fieldOf(headers, 'retry-after-ms'));
  if (fieldOf(headers, 'retry-after-ms') !== undefined && Number.isFinite(milliseconds)) return milliseconds;
  const seconds = Number(fieldOf(headers, 'retry-after'));
  if (fieldOf(headers, 'retry-after') !== undefined && Number.isFinite(seconds)) return seconds * 1000;
  return undefined;
}

function waitFromMessage(error: unknown): number | undefined {
  const [, minutes, amount, unit] = WAIT_STATED_IN_MESSAGE.exec(errorMessage(error)) ?? [];
  if (minutes === undefined && amount === undefined) return undefined;
  const rest = amount === undefined ? 0 : Number(amount) * (unit === 'ms' ? 1 : 1000);
  return Number(minutes ?? 0) * 60_000 + rest;
}

export function retryAfterMs(error: unknown): number | undefined {
  const lastAttempt = fieldOf(error, 'lastError') ?? error;
  return waitFromHeaders(lastAttempt) ?? waitFromMessage(lastAttempt);
}

export function handOverReasonFor(error: unknown): HandOverReason | undefined {
  if (isRateLimited(error)) return 'rate-limited';
  if (SEARCHED_WHEN_NOT_ALLOWED.test(errorMessage(error))) return 'searched-when-not-allowed';
  return undefined;
}

export function worthWaitingFor(
  outcome: AnswerOutcome,
): outcome is { reason: 'rate-limited'; retryAfterMs: number } {
  return (
    outcome.reason === 'rate-limited' &&
    outcome.retryAfterMs !== undefined &&
    outcome.retryAfterMs <= LONGEST_WAIT_WORTH_RETRYING_MS
  );
}

export async function forwardAnswer(
  answer: AnswerStream,
  sink: ChunkSink,
  opts: { continuesOpenMessage: boolean; handsOver: boolean },
): Promise<AnswerOutcome> {
  const failure: AnswerOutcome = {};
  const reader = answer
    .toUIMessageStream({
      sendReasoning: false,
      sendStart: !opts.continuesOpenMessage,
      onError: (error) => {
        failure.reason = handOverReasonFor(error);
        failure.retryAfterMs = failure.reason === 'rate-limited' ? retryAfterMs(error) : undefined;
        return userFacingError(error);
      },
    })
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return {};
    if (value.type === 'error' && failure.reason && opts.handsOver) {
      await reader.cancel();
      return failure;
    }
    sink.write(value);
  }
}

export type AnswerAttempts = {
  fromMainModel: () => AnswerStream;
  fromMainModelWithoutTools: () => AnswerStream;
  fromFastModelWithoutTools: () => AnswerStream;
  usedItsFollowUpSearch: () => boolean;
};

const FALLING_BACK_STATUS = 'The main model is rate limited: answering with the smaller model…';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function answerWithFallback(
  attempts: AnswerAttempts,
  sink: ChunkSink,
  status: (text: string) => void,
): Promise<void> {
  let outcome = await forwardAnswer(attempts.fromMainModel(), sink, { continuesOpenMessage: false, handsOver: true });
  if (worthWaitingFor(outcome)) {
    status(`The main model is busy: retrying in ${Math.ceil(outcome.retryAfterMs / 1000)} s…`);
    await sleep(outcome.retryAfterMs);
    const retry = attempts.usedItsFollowUpSearch() ? attempts.fromMainModelWithoutTools() : attempts.fromMainModel();
    outcome = await forwardAnswer(retry, sink, { continuesOpenMessage: true, handsOver: true });
  }
  if (!outcome.reason) return;

  const mainModelIsRateLimited = outcome.reason === 'rate-limited';
  if (mainModelIsRateLimited) {
    status(FALLING_BACK_STATUS);
    sink.write({ type: 'data-notice', data: SMALLER_MODEL_NOTICE });
  }
  const lastAnswer = mainModelIsRateLimited ? attempts.fromFastModelWithoutTools() : attempts.fromMainModelWithoutTools();
  await forwardAnswer(lastAnswer, sink, { continuesOpenMessage: true, handsOver: false });
}

export type ModelPair = { main: string; fast: string };
export type ModelCall<T> = (modelId: string, isFastModel: boolean) => Promise<T>;

export async function callWithFallback<T>(
  call: ModelCall<T>,
  models: ModelPair,
  status: (text: string) => void,
): Promise<{ result: T; modelId: string; usedFastModel: boolean }> {
  const viaMain = async () => ({
    result: await call(models.main, models.main === models.fast),
    modelId: models.main,
    usedFastModel: false,
  });
  try {
    return await viaMain();
  } catch (error) {
    if (!isRateLimited(error)) throw error;
    const wait = retryAfterMs(error);
    if (wait !== undefined && wait <= LONGEST_WAIT_WORTH_RETRYING_MS) {
      status(`The main model is busy: retrying in ${Math.ceil(wait / 1000)} s…`);
      await sleep(wait);
      try {
        return await viaMain();
      } catch (again) {
        if (!isRateLimited(again)) throw again;
      }
    }
    status(FALLING_BACK_STATUS);
    return { result: await call(models.fast, true), modelId: models.fast, usedFastModel: true };
  }
}
