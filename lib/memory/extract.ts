import { groq } from '@ai-sdk/groq';
import { generateText } from 'ai';
import { z } from 'zod';
import { getConfig } from '../config';
import type { NumberedResult } from '../search/web-search-tool';
import type { Claim } from './store';

const MAX_CLAIMS = 10;

const Output = z.object({
  claims: z.array(
    z.object({
      subject: z.string().min(1),
      attribute: z.string().min(1),
      value: z.coerce.string().min(1),
      source: z.coerce.number().nullish(),
    }),
  ),
});

const SYSTEM = `Extract the checkable facts from the answer: prices, versions, dates, plan limits, launches. Skip opinions and anything vague. At most ${MAX_CLAIMS}.
Reply with JSON only, in this shape: {"claims":[{"subject":"Neon","attribute":"Launch plan price","value":"$19/month","source":1}]}
"source" is the number of the [n] citation the fact carries, or null.`;

const FACT_KEY = /^(name|role|location|preference_[a-z0-9_]{1,30})$/;
const Facts = z.object({ facts: z.array(z.object({ key: z.string(), value: z.coerce.string().min(1).max(200) })) });

const FACTS_SYSTEM = `From the user's message, extract stable facts the user states about themselves: their name, role (job or profession), location, and lasting preferences.
Keys must be exactly "name", "role", "location" or "preference_<topic>" (for example "preference_language").
Only facts stated in this message, about the user. Copy each value word for word from the message; never guess. Ignore questions, requests, and passing moods or plans.
Reply with JSON only: {"facts":[{"key":"name","value":"Asha"}]}, or {"facts":[]} when there are none.`;

export const mentionsSelf = (text: string) => /\b(i|i'm|im|my|me|mine|myself)\b/i.test(text);

export async function extractUserFacts(userText: string): Promise<{ key: string; value: string }[]> {
  const { text } = await generateText({
    model: groq(getConfig().FAST_MODEL),
    temperature: 0,
    system: FACTS_SYSTEM,
    prompt: userText.slice(0, 2000),
  });
  const { facts } = Facts.parse(JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? ''));
  return facts
    .map((f) => ({ key: f.key.trim().toLowerCase().replace(/\s+/g, '_'), value: f.value.trim() }))
    .filter((f) => FACT_KEY.test(f.key) && userText.toLowerCase().includes(f.value.toLowerCase()))
    .slice(0, 5);
}

export async function extractClaims(answer: string, sources: NumberedResult[]): Promise<Claim[]> {
  const { text } = await generateText({
    model: groq(getConfig().FAST_MODEL),
    temperature: 0,
    system: SYSTEM,
    prompt: `Answer:\n${answer.slice(0, 4000)}\n\nSources:\n${sources.map((s) => `[${s.n}] ${s.title} ${s.url}`).join('\n')}`,
  });
  const { claims } = Output.parse(JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? ''));
  return claims.slice(0, MAX_CLAIMS).map((c) => ({
    subject: c.subject,
    attribute: c.attribute,
    value: c.value,
    sourceUrl: sources.find((s) => s.n === c.source)?.url,
  }));
}
