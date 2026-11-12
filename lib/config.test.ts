import { afterEach, expect, test, vi } from 'vitest';
import { dbPath, getConfig, now, tz } from './config';

const OPTIONAL = ['AGENT_NOW', 'AGENT_TZ', 'DB_PATH', 'MAIN_MODEL', 'FAST_MODEL'];
const stub = (names: string[], value: string) => names.forEach((n) => vi.stubEnv(n, value));
afterEach(() => vi.unstubAllEnvs());

test.each(['', '   '])('optional settings left as %j fall back to their defaults', (blank) => {
  stub(['GROQ_API_KEY', 'TAVILY_API_KEY'], 'key');
  stub(OPTIONAL, blank);
  expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000);
  expect(tz()).toBe('Asia/Kolkata');
  expect(dbPath()).toBe('data/agent.db');
  expect(getConfig()).toMatchObject({ MAIN_MODEL: 'openai/gpt-oss-120b', FAST_MODEL: 'openai/gpt-oss-20b' });
});

test('values that are set are used', () => {
  stub(['GROQ_API_KEY', 'TAVILY_API_KEY'], 'key');
  vi.stubEnv('AGENT_NOW', '2026-11-09T10:00:00+05:30');
  vi.stubEnv('AGENT_TZ', 'Europe/London');
  vi.stubEnv('MAIN_MODEL', 'some/model');
  expect(now().toISOString()).toBe('2026-11-09T04:30:00.000Z');
  expect(tz()).toBe('Europe/London');
  expect(getConfig().MAIN_MODEL).toBe('some/model');
});

test('only the two API keys are required, and an empty one counts as missing', () => {
  stub(OPTIONAL, '');
  vi.stubEnv('GROQ_API_KEY', '');
  vi.stubEnv('TAVILY_API_KEY', 'key');
  expect(() => getConfig()).toThrow('Missing environment variable(s): GROQ_API_KEY.');
  vi.stubEnv('TAVILY_API_KEY', ' ');
  expect(() => getConfig()).toThrow('GROQ_API_KEY, TAVILY_API_KEY');
});

test('a malformed AGENT_NOW is reported, not silently ignored', () => {
  vi.stubEnv('AGENT_NOW', 'next tuesday');
  expect(() => now()).toThrow('AGENT_NOW is not a valid ISO date: next tuesday');
});
