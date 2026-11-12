import type { UIMessageChunk } from 'ai';
import { errorMessage, isRateLimited, userFacingError } from './budget';

export const SMALLER_MODEL_NOTICE = 'Answered with a smaller model due to rate limits.';

const SEARCHED_WHEN_NOT_ALLOWED = /tool choice is none|called a tool|not in request\.tools|tool_use_failed|failed to call a function/i;

export type HandOverReason = 'rate-limited' | 'searched-when-not-allowed';
export type AnswerOutcome = 'answered' | HandOverReason;
export type AnswerStream = {
  toUIMessageStream: (options: {
    sendReasoning: boolean;
    sendStart: boolean;
    onError: (error: unknown) => string;
  }) => ReadableStream<UIMessageChunk>;
};
export type ChunkSink = { write: (chunk: UIMessageChunk) => void };

export function handOverReasonFor(error: unknown): HandOverReason | undefined {
  if (isRateLimited(error)) return 'rate-limited';
  if (SEARCHED_WHEN_NOT_ALLOWED.test(errorMessage(error))) return 'searched-when-not-allowed';
  return undefined;
}

export async function forwardAnswer(
  answer: AnswerStream,
  sink: ChunkSink,
  opts: { continuesOpenMessage: boolean; handsOver: boolean },
): Promise<AnswerOutcome> {
  const failure: { reason?: HandOverReason } = {};
  const reader = answer
    .toUIMessageStream({
      sendReasoning: false,
      sendStart: !opts.continuesOpenMessage,
      onError: (error) => {
        failure.reason = handOverReasonFor(error);
        return userFacingError(error);
      },
    })
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return 'answered';
    if (value.type === 'error' && failure.reason && opts.handsOver) {
      await reader.cancel();
      return failure.reason;
    }
    sink.write(value);
  }
}
