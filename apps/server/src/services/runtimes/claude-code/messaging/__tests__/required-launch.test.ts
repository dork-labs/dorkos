import { describe, expect, it } from 'vitest';
import { enforceRequiredClaudeConfiguration } from '../launch/required-launch.js';

const requirement = {
  runtime: 'claude-code' as const,
  root: '/accounts/exact',
  inference: 'own-account' as const,
  billing: 'subscription' as const,
};
describe('required Claude final launch configuration', () => {
  it('accepts only the exact root and inference/billing mode', () => {
    expect(() =>
      enforceRequiredClaudeConfiguration(requirement, '/accounts/exact', false, {})
    ).not.toThrow();
    expect(() =>
      enforceRequiredClaudeConfiguration(requirement, '/accounts/different', false, {})
    ).toThrow();
    expect(() =>
      enforceRequiredClaudeConfiguration(requirement, '/accounts/exact', false, {
        ANTHROPIC_API_KEY: 'edge-test-only',
      })
    ).toThrow();
    expect(() =>
      enforceRequiredClaudeConfiguration(requirement, '/accounts/exact', true, {})
    ).toThrow();
  });
  it('continues refusing a changed bill after native settlement', () => {
    const settled = { ...requirement, state: 'settled' };
    expect(() =>
      enforceRequiredClaudeConfiguration(settled, '/accounts/exact', false, {
        ANTHROPIC_API_KEY: 'edge-test-only',
      })
    ).toThrow();
  });
  it('does not substitute own sign-in for required credits or per-token billing', () => {
    expect(() =>
      enforceRequiredClaudeConfiguration(
        { ...requirement, inference: 'credits', billing: 'per-token' },
        '/accounts/exact',
        false,
        {}
      )
    ).toThrow();
    expect(() =>
      enforceRequiredClaudeConfiguration(
        { ...requirement, billing: 'per-token' },
        '/accounts/exact',
        false,
        {}
      )
    ).toThrow();
  });
});
