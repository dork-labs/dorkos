import { describe, it, expect } from 'vitest';
import {
  AGENT_NAME_REGEX,
  validateAgentName,
  slugifyAgentName,
  getAgentDisplayName,
} from '../validation.js';
import { CreateAgentOptionsSchema } from '../mesh-schemas.js';

describe('AGENT_NAME_REGEX', () => {
  it('rejects path traversal characters', () => {
    expect(AGENT_NAME_REGEX.test('../traversal')).toBe(false);
  });

  it('rejects hidden file names', () => {
    expect(AGENT_NAME_REGEX.test('.hidden')).toBe(false);
  });
});

describe('validateAgentName', () => {
  it('returns error for path traversal', () => {
    const result = validateAgentName('../traversal');
    expect(result.valid).toBe(false);
  });

  it('returns error for names exceeding 64 characters', () => {
    const name = 'a' + 'b'.repeat(64);
    expect(name.length).toBeGreaterThan(64);
    const result = validateAgentName(name);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Name must be 64 characters or less');
  });
});

describe('CreateAgentOptionsSchema', () => {
  it('rejects a name with path traversal characters', () => {
    expect(() => CreateAgentOptionsSchema.parse({ name: '../evil' })).toThrow();
  });
});

describe('slugifyAgentName', () => {
  // The trim used to be `^-+|-+$`, which CodeQL flags as quadratic
  // (js/polynomial-redos). The collapse above it makes a hyphen run impossible,
  // so `^-|-$` answers identically — these cases are the proof, and the timed
  // one is what a long run costs now.
  it.each([
    ['---', 'agent'],
    ['-', 'agent'],
    ['a---b', 'a-b'],
    ['---a---', 'a'],
    ['- - -', 'agent'],
    ['a - - - b', 'a-b'],
    ['!!!hello!!!', 'hello'],
  ])('slugifies the hyphen-heavy %j to %j', (input, expected) => {
    expect(slugifyAgentName(input)).toBe(expected);
  });

  it('produces slugs that pass AGENT_NAME_REGEX', () => {
    const inputs = ['My Cool Agent', 'DorkBot v2', 'API Server', '123 test', 'hello'];
    for (const input of inputs) {
      const slug = slugifyAgentName(input);
      expect(AGENT_NAME_REGEX.test(slug)).toBe(true);
    }
  });
});

describe('getAgentDisplayName', () => {
  it('falls back to name when displayName is empty string', () => {
    expect(getAgentDisplayName({ displayName: '', name: 'my-agent' })).toBe('my-agent');
  });

  it('returns default fallback for null agent', () => {
    expect(getAgentDisplayName(null)).toBe('Agent');
  });
});
