import { z } from 'zod';
import { BrowserValidationError } from './errors.js';
import { parseValidated } from './validation.js';

/** Internal schema for generation/revision identities; never wrap an exhausted value. */
export const CounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Increment a safe counter, requiring the lifecycle owner to stop/freshen on exhaustion. */
export function advanceCounter(value: number): number {
  const current = parseValidated(CounterSchema, value, 'INVALID_COUNTER');
  if (current === Number.MAX_SAFE_INTEGER) throw new BrowserValidationError('COUNTER_EXHAUSTED');
  return current + 1;
}
