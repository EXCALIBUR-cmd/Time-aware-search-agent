import { expect, test } from 'vitest';
import { reportsAConfirmedChange } from './verdict';

test('only a verdict that reports a confirmed change gets the amber callout', () => {
  expect(reportsAConfirmedChange('One price changed since these prices were checked on Tue 3 Nov.')).toBe(true);
  expect(reportsAConfirmedChange("Three prices changed since Tue 3 Nov; one price couldn't be confirmed.")).toBe(true);
  expect(reportsAConfirmedChange('Nothing has changed since these prices were checked on Tue 3 Nov.')).toBe(false);
  expect(reportsAConfirmedChange("2 of 9 prices confirmed unchanged; 7 couldn't be confirmed.")).toBe(false);
  expect(reportsAConfirmedChange('0 of 1 prices confirmed unchanged; 1 has conflicting sources.')).toBe(false);
});
