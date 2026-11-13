import { z } from 'zod';

const nonBlankEnv = (name: string) => process.env[name]?.trim() || undefined;

const DEFAULT_MAIN_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_FAST_MODEL = 'openai/gpt-oss-20b';

const schema = z.object({
  GROQ_API_KEY: z.string(),
  TAVILY_API_KEY: z.string(),
  MAIN_MODEL: z.string().default(DEFAULT_MAIN_MODEL),
  FAST_MODEL: z.string().default(DEFAULT_FAST_MODEL),
});

export const FAST_MODEL_PROVIDER_OPTIONS = { groq: { reasoningEffort: 'low', reasoningFormat: 'hidden' } };

export function getConfig() {
  const parsed = schema.safeParse({
    GROQ_API_KEY: nonBlankEnv('GROQ_API_KEY'),
    TAVILY_API_KEY: nonBlankEnv('TAVILY_API_KEY'),
    MAIN_MODEL: nonBlankEnv('MAIN_MODEL'),
    FAST_MODEL: nonBlankEnv('FAST_MODEL'),
  });
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Missing environment variable(s): ${keys}. Copy .env.example to .env and fill them in.`);
  }
  return parsed.data;
}

export function now(): Date {
  const fixed = nonBlankEnv('AGENT_NOW');
  const d = fixed ? new Date(fixed) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error(`AGENT_NOW is not a valid ISO date: ${fixed}`);
  return d;
}

export const mainModel = () => nonBlankEnv('MAIN_MODEL') ?? DEFAULT_MAIN_MODEL;

export const tz = () => nonBlankEnv('AGENT_TZ') ?? 'Asia/Kolkata';

export const dbPath = () => nonBlankEnv('DB_PATH') ?? 'data/agent.db';
