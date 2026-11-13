import type { UIMessageChunk } from 'ai';
import { expect, test } from 'vitest';
import { BUSY_MESSAGE, isRateLimited } from './budget';
import { forwardAnswer, handOverReasonFor, retryAfterMs, worthWaitingFor, type AnswerStream } from './fallback';

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
  const outcome = await forwardAnswer(answerThat(textChunks('hello')), sink, { continuesOpenMessage: false, handsOver: true });
  expect(outcome).toEqual({});
  expect(written.map((c) => c.type)).toEqual(['text-start', 'text-delta', 'text-end']);
});

test('a rate-limited main model hands over without showing its error', async () => {
  const { written, sink } = collect();
  const main = answerThat([{ type: 'start' }], RATE_LIMIT_AFTER_RETRY);
  const outcome = await forwardAnswer(main, sink, { continuesOpenMessage: false, handsOver: true });
  expect(outcome).toEqual({ reason: 'rate-limited', retryAfterMs: 4695 });
  expect(written.map((c) => c.type)).toEqual(['start']);
  expect(main.sawSendStart).toBe(true);

  const fallback = answerThat(textChunks('answer from the smaller model'));
  expect(await forwardAnswer(fallback, sink, { continuesOpenMessage: true, handsOver: false })).toEqual({});
  expect(fallback.sawSendStart).toBe(false);
  expect(written.map((c) => c.type)).toEqual(['start', 'text-start', 'text-delta', 'text-end']);
});

test('if the smaller model is rate limited too, the friendly message is shown', async () => {
  const { written, sink } = collect();
  const outcome = await forwardAnswer(answerThat([], RATE_LIMIT_AFTER_RETRY), sink, { continuesOpenMessage: true, handsOver: false });
  expect(outcome).toEqual({});
  expect(written).toEqual([{ type: 'error', errorText: BUSY_MESSAGE }]);
});

test('other failures of the main model are shown, not handed over', async () => {
  const { written, sink } = collect();
  const outcome = await forwardAnswer(answerThat([], TOO_LARGE), sink, { continuesOpenMessage: false, handsOver: true });
  expect(outcome).toEqual({});
  expect(written).toEqual([{ type: 'error', errorText: BUSY_MESSAGE }]);
});

test('a model that searches when it has no searches left hands over for a plain answer', async () => {
  const groqRefusal = { message: 'Tool choice is none, but model called a tool', type: 'invalid_request_error' };
  expect(handOverReasonFor(groqRefusal)).toBe('searched-when-not-allowed');
  expect(handOverReasonFor(RATE_LIMIT_AFTER_RETRY)).toBe('rate-limited');
  expect(handOverReasonFor(TOO_LARGE)).toBeUndefined();

  const { written, sink } = collect();
  const main = answerThat([{ type: 'start' }], groqRefusal);
  expect(await forwardAnswer(main, sink, { continuesOpenMessage: false, handsOver: true })).toEqual({ reason: 'searched-when-not-allowed', retryAfterMs: undefined });
  expect(written.map((c) => c.type)).toEqual(['start']);
});

test('the wait Groq asks for is read from the headers first, then from the message', () => {
  const withHeaders = (responseHeaders: Record<string, string>) =>
    Object.assign(new Error('Rate limit reached. Please try again in 9s.'), { responseHeaders });
  expect(retryAfterMs(withHeaders({ 'retry-after': '3' }))).toBe(3000);
  expect(retryAfterMs(withHeaders({ 'retry-after-ms': '750', 'retry-after': '1' }))).toBe(750);
  expect(retryAfterMs(RATE_LIMIT_AFTER_RETRY)).toBe(4695);
  expect(retryAfterMs(new Error('Rate limit reached. Please try again in 350ms.'))).toBe(350);
  expect(retryAfterMs(new Error('Rate limit reached. Please try again in 1m30.5s.'))).toBe(90_500);
  expect(retryAfterMs(new Error('Rate limit reached. Please try again in 2m.'))).toBe(120_000);
  expect(retryAfterMs(new Error('Rate limit reached.'))).toBeUndefined();
  expect(retryAfterMs({ lastError: withHeaders({ 'retry-after': '2' }) })).toBe(2000);
});

test('only a wait of 5 s or less is worth a retry; a longer or unknown wait hands over at once', () => {
  expect(worthWaitingFor({ reason: 'rate-limited', retryAfterMs: 4695 })).toBe(true);
  expect(worthWaitingFor({ reason: 'rate-limited', retryAfterMs: 5000 })).toBe(true);
  expect(worthWaitingFor({ reason: 'rate-limited', retryAfterMs: 5001 })).toBe(false);
  expect(worthWaitingFor({ reason: 'rate-limited', retryAfterMs: 14_228 })).toBe(false);
  expect(worthWaitingFor({ reason: 'rate-limited' })).toBe(false);
  expect(worthWaitingFor({ reason: 'searched-when-not-allowed', retryAfterMs: 100 })).toBe(false);
  expect(worthWaitingFor({})).toBe(false);
});
