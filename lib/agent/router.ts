import { groq } from '@ai-sdk/groq';
import { generateText } from 'ai';
import { z } from 'zod';
import { FAST_MODEL_PROVIDER_OPTIONS, getConfig } from '../config';

export type Mode = 'chat' | 'fresh' | 'recall' | 'reverify';

const Output = z.object({ mode: z.enum(['chat', 'fresh', 'recall', 'reverify']) });

const SYSTEM = `Classify the user's message for a chat agent. Reply with JSON only: {"mode":"chat"} or "fresh", "recall", "reverify".
chat: greetings, thanks, small talk, questions about the assistant.
fresh: needs current information from the web, or follows up on the current chat.
recall: asks what was said or asked in a past conversation.
reverify: asks whether something discussed in a past conversation has changed or is still correct.`;

const MEMORY_PHRASE = /\b(remember|did i (tell|say|ask|mention)|what did i (tell|say|ask)|i (told|said|mentioned))\b/i;
const RECHECK_WORDS = /\b(still|chang\w*|since|updat\w*|shipped|now)\b/i;

export function applyOverrides(mode: Mode, text: string, hasPastDate: boolean): Mode {
  if (mode === 'reverify') return mode;
  if (hasPastDate) return RECHECK_WORDS.test(text) ? 'reverify' : 'recall';
  return MEMORY_PHRASE.test(text) ? 'recall' : mode;
}

export async function route(text: string, hasPastDate: boolean): Promise<Mode> {
  let mode: Mode = 'fresh';
  try {
    const { text: out } = await generateText({
      model: groq(getConfig().FAST_MODEL),
      providerOptions: FAST_MODEL_PROVIDER_OPTIONS,
      system: SYSTEM,
      prompt: text,
      temperature: 0,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(1500),
    });
    mode = Output.parse(JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? '')).mode;
  } catch {}
  return applyOverrides(mode, text, hasPastDate);
}
