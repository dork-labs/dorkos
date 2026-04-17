import { describe, it, expect } from 'vitest';
import { formatTerminalReason } from '../ui/status/terminal-reason-labels';

// Purpose: humaniseRawReason must handle edge cases (empty, single word,
// mixed separators) without throwing — forward-compat is pointless if a
// malformed SDK value crashes the client.
describe('formatTerminalReason fallback', () => {
  it('uppercases the first word and lowercases the rest', () => {
    expect(formatTerminalReason('FOO_BAR_BAZ')).toBe('Foo bar baz');
  });
  it('handles hyphen separators', () => {
    expect(formatTerminalReason('foo-bar')).toBe('Foo bar');
  });
  it('handles single-word values', () => {
    expect(formatTerminalReason('ended')).toBe('Ended');
  });
});
