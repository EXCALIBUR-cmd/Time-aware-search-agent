const CONFIRMED_CHANGE = /^\w+ prices? changed since\b/i;

export const reportsAConfirmedChange = (verdict: string): boolean => CONFIRMED_CHANGE.test(verdict.trim());
