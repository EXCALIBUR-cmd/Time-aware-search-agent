import { createUIMessageStreamResponse } from 'ai';
import { z } from 'zod';
import { runAgent } from '@/lib/agent/run';

const Body = z.object({
  id: z.string().min(1).max(100),
  messages: z.array(z.object({ role: z.string(), parts: z.array(z.looseObject({ type: z.string() })) })).min(1),
  now: z.iso.datetime().optional(),
});

export async function POST(req: Request) {
  try {
    const body = Body.safeParse(await req.json());
    const last = body.data?.messages.at(-1);
    const text = (last?.parts ?? [])
      .map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .join('')
      .trim();
    if (!body.success || last?.role !== 'user' || !text) return new Response('Invalid request: send a non-empty message.', { status: 400 });
    const simulatedNow =
      process.env.NODE_ENV === 'development' && body.data.now ? new Date(body.data.now) : undefined;
    if (simulatedNow && simulatedNow.getTime() > Date.now() + 60_000) {
      return new Response('The simulated date cannot be in the future.', { status: 400 });
    }
    return createUIMessageStreamResponse({
      stream: runAgent({ conversationId: body.data.id, text: text.slice(0, 4000), simulatedNow }),
    });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : 'Server error', { status: 500 });
  }
}
