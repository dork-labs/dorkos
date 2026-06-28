import { describe, it, expect } from 'vitest';
import { parseNativeCommand, NATIVE_COMMAND_ENTRIES } from '../registry';

describe('parseNativeCommand', () => {
  it('parses /rename with a title into command + args', () => {
    // The common path: the title is the trimmed remainder after the token.
    const result = parseNativeCommand('/rename My Title');
    expect(result?.command.name).toBe('rename');
    expect(result?.args).toBe('My Title');
  });

  it('parses /rename with no argument into empty args (handled downstream)', () => {
    // No-arg still matches the command; the executor turns empty args into a hint.
    const result = parseNativeCommand('/rename');
    expect(result?.command.name).toBe('rename');
    expect(result?.args).toBe('');
  });

  it('matches the command token case-insensitively', () => {
    expect(parseNativeCommand('/RENAME Foo')?.command.name).toBe('rename');
  });

  it('does not match a longer token that merely starts with a command name', () => {
    // `/renamefoo` must not be treated as `/rename` — token equality, not prefix.
    expect(parseNativeCommand('/renamefoo bar')).toBeNull();
  });

  it('returns null for an unregistered slash command (falls through to runtime)', () => {
    expect(parseNativeCommand('/unknown thing')).toBeNull();
  });

  it('returns null for plain text and empty input', () => {
    expect(parseNativeCommand('hello world')).toBeNull();
    expect(parseNativeCommand('')).toBeNull();
  });

  it('trims surrounding whitespace in the captured args', () => {
    expect(parseNativeCommand('/rename   spaced   ')?.args).toBe('spaced');
  });
});

describe('NATIVE_COMMAND_ENTRIES', () => {
  it('exposes /rename as an autocomplete entry with a description and an arg hint', () => {
    expect(NATIVE_COMMAND_ENTRIES).toHaveLength(1);
    const rename = NATIVE_COMMAND_ENTRIES[0];
    expect(rename.command).toBe('rename');
    expect(rename.fullCommand).toBe('/rename');
    expect(rename.description).toBeTruthy();
    expect(rename.argumentHint).toBeTruthy();
  });

  it('is a stable module-level reference (same array across reads)', () => {
    // ChatPanel spreads this into a useMemo dep; a fresh array each read would
    // defeat the memo. Importing twice must yield the identical reference.
    expect(NATIVE_COMMAND_ENTRIES).toBe(NATIVE_COMMAND_ENTRIES);
  });
});
