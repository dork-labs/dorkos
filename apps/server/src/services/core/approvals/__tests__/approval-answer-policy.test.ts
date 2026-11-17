/** Decisions are classified by their server-known effect, never their button wording. */
import { describe, expect, it } from 'vitest';
import { grantsPower } from '../model/approval-answer-policy.js';

describe('grantsPower', () => {
  it.each([
    'deny',
    'reject',
    'revoke',
    'dismiss',
    'lower',
    'model-input',
    'plain-choice',
    'runtime-tool-once',
    'mcp-form-input',
  ])('leaves %s free', (kind) => {
    expect(grantsPower({ kind })).toBe(false);
  });
  it.each([
    'approve',
    'runtime-tool-always',
    'plan-mode-change',
    'offer-accept',
    'extension-answer',
    'extension-room-access',
    'extension-forward-agents',
    'future-unclassified-kind',
  ])('holds %s', (kind) => {
    expect(grantsPower({ kind })).toBe(true);
  });
  it('holds the whole batch if any member grants power or is unknown', () => {
    expect(
      grantsPower({
        kind: 'batch',
        items: [{ kind: 'model-input' }, { kind: 'runtime-tool-always' }],
      })
    ).toBe(true);
    expect(grantsPower({ kind: 'batch', items: [{ kind: 'future-kind' }] })).toBe(true);
    expect(grantsPower({ kind: 'batch' })).toBe(true);
    expect(grantsPower({ kind: 'batch', items: [] })).toBe(true);
    expect(grantsPower({ kind: 'batch', items: [{ kind: 'model-input' }, { kind: 'deny' }] })).toBe(
      false
    );
  });
});
