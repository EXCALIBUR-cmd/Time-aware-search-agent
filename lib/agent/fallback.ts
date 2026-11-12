import type { UIMessageChunk } from 'ai';
import { isRateLimited, userFacingError } from './budget';

export const SMALLER_MODEL_NOTICE = 'Answered with a smaller model due to rate limits.';

export type AnswerStream = {
  toUIMessageStream: (options: {
    sendReasoning: boolean;
    sendStart: boolean;
    onError: (error: unknown) => string;
  }) => ReadableStream<UIMessageChunk>;
};
export type ChunkSink = { write: (chunk: UIMessageChunk) => void };

export async function forwardAnswer(
  answer: AnswerStream,
  sink: ChunkSink,
  opts: { continuesOpenMessage: boolean; stopOnRateLimit: boolean },
): Promise<'answered' | 'rate-limited'> {
  let rateLimited = false;
  const reader = answer
    .toUIMessageStream({
      sendReasoning: false,
      sendStart: !opts.continuesOpenMessage,
      onError: (error) => {
        rateLimited = isRateLimited(error);
        return userFacingError(error);
      },
    })
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return 'answered';
    const handOverToFallback = value.type === 'error' && rateLimited && opts.stopOnRateLimit;
    if (handOverToFallback) {
      await reader.cancel();
      return 'rate-limited';
    }
    sink.write(value);
  }
}
