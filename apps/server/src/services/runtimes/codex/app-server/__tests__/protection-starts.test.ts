import { expect, it } from 'vitest';
import { assertProtectionStarts } from './fixtures/protection-starts.js';

it('requires a started protection row at every level, including Edit', () => {
  const complete = { default: 2, acceptEdits: 4, bypassPermissions: 4 };
  expect(() => assertProtectionStarts(complete)).not.toThrow();
  for (const mode of Object.keys(complete))
    expect(() => assertProtectionStarts({ ...complete, [mode]: 0 })).toThrow(mode);
  expect(() => assertProtectionStarts({ default: 2, bypassPermissions: 4 })).toThrow('acceptEdits');
});
