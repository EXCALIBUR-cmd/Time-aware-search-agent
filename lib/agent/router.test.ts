import { expect, test } from 'vitest';
import { applyOverrides, parsePlan } from './router';

test('the router plan is validated: a mode and at most 4 trimmed, non-empty queries', () => {
  expect(parsePlan('{"mode":"fresh","queries":["Neon pricing"," Supabase pricing "]}')).toEqual({
    mode: 'fresh',
    queries: ['Neon pricing', 'Supabase pricing'],
  });
  expect(parsePlan('Sure! {"mode":"chat"}')).toEqual({ mode: 'chat', queries: [] });
  expect(parsePlan('{"mode":"reverify","queries":["a","b","","c","d","e"]}').queries).toEqual(['a', 'b', 'c', 'd']);
  expect(() => parsePlan('{"mode":"search","queries":["a"]}')).toThrow();
  expect(() => parsePlan('{"mode":"fresh","queries":"Neon pricing"}')).toThrow();
  expect(() => parsePlan('no json here')).toThrow();
});

test.each(['do you remember my name?', 'Did I tell you where I live?', 'what did I say about Postgres?', 'i told you that already'])(
  'memory phrase routes to recall: %s',
  (text) => {
    expect(applyOverrides('chat', text, false)).toBe('recall');
    expect(applyOverrides('fresh', text, false)).toBe('recall');
  },
);

test('a past date means memory; re-check wording makes it reverify', () => {
  expect(applyOverrides('fresh', 'What did I tell you on 1 November?', true)).toBe('recall');
  expect(applyOverrides('fresh', 'Has any pricing changed since then?', true)).toBe('reverify');
});

test('everything else keeps the model’s choice', () => {
  expect(applyOverrides('fresh', "What's the latest Next.js version?", false)).toBe('fresh');
  expect(applyOverrides('chat', 'Thanks!', false)).toBe('chat');
  expect(applyOverrides('reverify', 'do you remember if Neon is still $19?', false)).toBe('reverify');
});
