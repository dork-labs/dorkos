import { describe, it, expect } from 'vitest';
import { chooseDefaultRuntime } from '../model/use-onboarding-runtime-default';

describe('chooseDefaultRuntime', () => {
  it('picks the one runtime that is actually ready', () => {
    expect(chooseDefaultRuntime(['codex'], 'claude-code')).toBe('codex');
  });

  it('leaves a ready default alone, whatever else is connected', () => {
    expect(chooseDefaultRuntime(['claude-code', 'codex'], 'claude-code')).toBe('claude-code');
    expect(chooseDefaultRuntime(['claude-code', 'codex'], 'codex')).toBe('codex');
  });

  it('prefers the product order rather than the order the scan happened to return', () => {
    expect(chooseDefaultRuntime(['opencode', 'codex'], 'claude-code')).toBe('codex');
    expect(chooseDefaultRuntime(['codex', 'opencode'], 'claude-code')).toBe('codex');
  });

  it('takes an unknown runtime over none at all', () => {
    expect(chooseDefaultRuntime(['some-fork'], 'claude-code')).toBe('some-fork');
  });

  it('decides nothing when nothing is ready', () => {
    expect(chooseDefaultRuntime([], 'claude-code')).toBeNull();
  });
});
