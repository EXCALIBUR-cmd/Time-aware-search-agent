import type { UIMessageChunk } from 'ai';
import { expect, test } from 'vitest';
import { BUSY_MESSAGE, isRateLimited } from './budget';
import { forwardAnswer, type AnswerStream } from './fallback';

const RATE_LIMIT_AFTER_RETRY = new Error(
  'Failed after 2 attempts. Last error: Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 4467, Requested 4159. Please try again in 4.695s.',
);
const TOO_LARGE = new Error('Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 9400.');

const textChunks = (text: string): UIMessageChunk[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
];

function answerThat(chunks: UIMessageChunk[], failsWith?: unknown): AnswerStream & { sawSendStart?: boolean } {
  const answer: AnswerStream & { sawSendStart?: boolean } = {
    toUIMessageStream: ({ sendStart, onError }) => {
      answer.sawSendStart = sendStart;
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          chunks.forEach((chunk) => controller.enqueue(chunk));
          if (failsWith !== undefined) controller.enqueue({ type: 'error', errorText: onError(failsWith) });
          controller.close();
        },
      });
    },
  };
  return answer;
}

const collect = () => {
  const written: UIMessageChunk[] = [];
  return { written, sink: { write: (chunk: UIMessageChunk) => void written.push(chunk) } };
};

test('only a 429 counts as rate limited; a too-large request does not', () => {
  expect(isRateLimited(RATE_LIMIT_AFTER_RETRY)).toBe(true);
  expect(isRateLimited(TOO_LARGE)).toBe(false);
  expect(isRateLimited(new Error('Tool choice is none, but model called a tool'))).toBe(false);
});

test('a normal answer is forwarded chunk by chunk', async () => {
  const { written, sink } = collect();
  const outcome = await forwardAnswer(answerThat(textChunks('hello')), sink, { continuesOpenMessage: false, stopOnRateLimit: true });
  expect(outcome).toBe('answered');
  expect(written.map((c) => c.type)).toEqual(['text-start', 'text-delta', 'text-end']);
});

test('a rate-limited main model hands over without showing its error', async () => {
  const { written, sink } = collect();
  const main = answerThat([{ type: 'start' }], RATE_LIMIT_AFTER_RETRY);
  const outcome = await forwardAnswer(main, sink, { continuesOpenMessage: false, stopOnRateLimit: true });
  expect(outcome).toBe('rate-limited');
  expect(written.map((c) => c.type)).toEqual(['start']);
  expect(main.sawSendStart).toBe(true);

  const fallback = answerThat(textChunks('answer from the smaller model'));
  expect(await forwardAnswer(fallback, sink, { continuesOpenMessage: true, stopOnRateLimit: false })).toBe('answered');
  expect(fallback.sawSendStart).toBe(false);
  expect(written.map((c) => c.type)).toEqual(['start', 'text-start', 'text-delta', 'text-end']);
});

test('if the smaller model is rate limited too, the friendly message is shown', async () => {
  const { written, sink } = collect();
  const outcome = await forwardAnswer(answerThat([], RATE_LIMIT_AFTER_RETRY), sink, { continuesOpenMessage: true, stopOnRateLimit: false });
  expect(outcome).toBe('answered');
  expect(written).toEqual([{ type: 'error', errorText: BUSY_MESSAGE }]);
});

test('other failures of the main model are shown, not handed over', async () => {
  const { written, sink } = collect();
  const outcome = await forwardAnswer(answerThat([], TOO_LARGE), sink, { continuesOpenMessage: false, stopOnRateLimit: true });
  expect(outcome).toBe('answered');
  expect(written).toEqual([{ type: 'error', errorText: BUSY_MESSAGE }]);
});
