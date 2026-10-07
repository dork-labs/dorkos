import { expect, it } from 'vitest';
import {
  BrowserCopySelectionRequestSchema,
  BrowserCopySelectionReceiptSchema,
  BrowserInputRequestSchema,
} from '../browser-schemas.js';
import { binding, reference } from './browser-schema-fixtures.js';
const request = { requestId: reference(9), binding };
it('copy never accepts a native target, selector, raw script, actor or text supplied by caller', () => {
  expect(BrowserCopySelectionRequestSchema.parse(request)).toEqual(request);
  for (const key of ['text', 'selector', 'script', 'frameId', 'page', 'actor', 'permission'])
    expect(
      BrowserCopySelectionRequestSchema.safeParse({ ...request, [key]: 'forged' }).success
    ).toBe(false);
});
it('bounds actual selected text UTF8 and refuses malformed Unicode without truncation', () => {
  for (const text of ['x'.repeat(2049), '😀'.repeat(513), '\uD800', ''])
    expect(
      BrowserCopySelectionReceiptSchema.safeParse({ ...request, outcome: 'selected', text }).success
    ).toBe(false);
  expect(
    BrowserCopySelectionReceiptSchema.parse({
      ...request,
      outcome: 'selected',
      text: '😀'.repeat(512),
    })
  ).toMatchObject({ outcome: 'selected' });
});
it('secret refusal has no value/length/selection payload', () => {
  expect(
    BrowserCopySelectionReceiptSchema.parse({ ...request, outcome: 'refused', reason: 'secret' })
  ).toEqual({ ...request, outcome: 'refused', reason: 'secret' });
  for (const key of ['text', 'value', 'length', 'selectionStart'])
    expect(
      BrowserCopySelectionReceiptSchema.safeParse({
        ...request,
        outcome: 'refused',
        reason: 'secret',
        [key]: 'forged',
      }).success
    ).toBe(false);
});
it('copy does not broaden native keys into a runtime OS clipboard shortcut', () => {
  expect(
    BrowserInputRequestSchema.safeParse({
      ...request,
      kind: 'input',
      steps: [{ kind: 'keyDown', key: 'C' }],
    }).success
  ).toBe(false);
});
