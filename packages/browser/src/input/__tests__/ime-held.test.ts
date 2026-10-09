import { expect, it } from 'vitest';
import { HeldInput } from '../held.js';
import { BrowserInputStepSchema } from '@dorkos/shared/browser-schemas';

it('retains native preedit until the original commit or cancellation acknowledgment', () => {
  const held = new HeldInput();
  held.track({ kind: 'composition', text: '中', selectionStart: 1, selectionEnd: 1 });
  expect(held.hasHeld()).toBe(true);
  held.track({ kind: 'compositionCommit', text: '中' });
  expect(held.hasHeld()).toBe(true);
  held.settled({ kind: 'compositionCommit', text: '中' });
  expect(held.hasHeld()).toBe(false);
  held.track({ kind: 'composition', text: '中', selectionStart: 1, selectionEnd: 1 });
  held.track({ kind: 'composition', text: '', selectionStart: 0, selectionEnd: 0 });
  expect(held.hasHeld()).toBe(true);
  held.settled({ kind: 'composition', text: '', selectionStart: 0, selectionEnd: 0 });
  expect(held.hasHeld()).toBe(false);
});
it('rejects invalid preedit selection and malformed or oversized text at the public boundary', () => {
  for (const value of [
    { kind: 'composition', text: '中', selectionStart: 2, selectionEnd: 2 },
    { kind: 'composition', text: '中文', selectionStart: 2, selectionEnd: 1 },
    { kind: 'compositionCommit', text: '\ud800' },
    { kind: 'compositionCommit', text: '中'.repeat(683) },
  ])
    expect(BrowserInputStepSchema.safeParse(value).success).toBe(false);
  expect(
    BrowserInputStepSchema.parse({
      kind: 'composition',
      text: '😀中',
      selectionStart: 2,
      selectionEnd: 3,
    })
  ).toMatchObject({ selectionStart: 2, selectionEnd: 3 });
});
