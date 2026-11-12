import { z } from 'zod';

const env = (name: string) => process.env[name]?.trim() || undefined;

const schema = z.object({
  GROQ_API_KEY: z.string(),
  TAVILY_API_KEY: z.string(),
  MAIN_MODEL: z.string().default('openai/gpt-oss-120b'),
  FAST_MODEL: z.string().default('openai/gpt-oss-20b'),
});

export function getConfig() {
  const parsed = schema.safeParse({
    GROQ_API_KEY: env('GROQ_API_KEY'),
    TAVILY_API_KEY: env('TAVILY_API_KEY'),
    MAIN_MODEL: env('MAIN_MODEL'),
    FAST_MODEL: env('FAST_MODEL'),
  });
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Missing environment variable(s): ${keys}. Copy .env.example to .env and fill them in.`);
  }
  return parsed.data;
}

export function now(): Date {
  const fixed = env('AGENT_NOW');
  const d = fixed ? new Date(fixed) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error(`AGENT_NOW is not a valid ISO date: ${fixed}`);
  return d;
}

export const tz = () => env('AGENT_TZ') ?? 'Asia/Kolkata';

export const dbPath = () => env('DB_PATH') ?? 'data/agent.db';
