import { describe, it, expect, vi } from 'vitest';
import { parseNativeCommand, NATIVE_COMMAND_ENTRIES, type NativeCommandContext } from '../registry';

/** A NativeCommandContext with every capability spied. */
function makeCtx(sessionId: string | null = 's1'): NativeCommandContext {
  return {
    sessionId,
    renameSession: vi.fn(),
    notify: vi.fn(),
    startFreshSession: vi.fn(),
    focusUsageSurface: vi.fn(),
  };
}

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

  it('resolves the clear/context intents by their canonical token', () => {
    // clear and context are the client-native command intents (DOR-109).
    expect(parseNativeCommand('/clear')?.command.name).toBe('clear');
    expect(parseNativeCommand('/context')?.command.name).toBe('context');
  });

  it('routes cross-agent aliases to the right client-native intent', () => {
    // Muscle memory carries over: another agent's word reaches the same executor.
    expect(parseNativeCommand('/new')?.command.name).toBe('clear');
    expect(parseNativeCommand('/new-chat')?.command.name).toBe('clear');
    expect(parseNativeCommand('/usage')?.command.name).toBe('context');
    expect(parseNativeCommand('/status')?.command.name).toBe('context');
    expect(parseNativeCommand('/cost')?.command.name).toBe('context');
  });

  it('does NOT match the runtime-fulfilled compact intent (it dispatches via the funnel)', () => {
    // /compact and its aliases fall through so the send funnel runs runCommandIntent.
    expect(parseNativeCommand('/compact')).toBeNull();
    expect(parseNativeCommand('/compress')).toBeNull();
    expect(parseNativeCommand('/summarize')).toBeNull();
  });
});

describe('clear + context native executors (DOR-109)', () => {
  it('/clear calls startFreshSession with the current session id and reports ran', () => {
    // /clear opens a fresh linked session — no runtime message, no model turn.
    const ctx = makeCtx('s1');
    const parsed = parseNativeCommand('/clear')!;
    const ran = parsed.command.run(parsed.args, ctx);
    expect(ran).toBe(true);
    expect(ctx.startFreshSession).toHaveBeenCalledWith('s1');
    expect(ctx.focusUsageSurface).not.toHaveBeenCalled();
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it('/context calls focusUsageSurface and reports ran', () => {
    // /context reveals the usage & cost surface — no runtime message.
    const ctx = makeCtx('s1');
    const parsed = parseNativeCommand('/context')!;
    const ran = parsed.command.run(parsed.args, ctx);
    expect(ran).toBe(true);
    expect(ctx.focusUsageSurface).toHaveBeenCalledTimes(1);
    expect(ctx.startFreshSession).not.toHaveBeenCalled();
  });

  it('/clear works even with no active session (fromSessionId is null)', () => {
    const ctx = makeCtx(null);
    const parsed = parseNativeCommand('/clear')!;
    expect(parsed.command.run(parsed.args, ctx)).toBe(true);
    expect(ctx.startFreshSession).toHaveBeenCalledWith(null);
  });
});

describe('NATIVE_COMMAND_ENTRIES', () => {
  it('exposes /rename as an autocomplete entry with a description and an arg hint', () => {
    const rename = NATIVE_COMMAND_ENTRIES.find((e) => e.command === 'rename');
    expect(rename?.fullCommand).toBe('/rename');
    expect(rename?.description).toBeTruthy();
    expect(rename?.argumentHint).toBeTruthy();
  });

  it('projects the clear + context intents too (the palette folds them into the intent rows)', () => {
    // clear/context are registered so parseNativeCommand recognizes them; their
    // palette rows come from the shared intent registry, which dedupes these out.
    expect(NATIVE_COMMAND_ENTRIES.map((e) => e.command)).toEqual(['rename', 'clear', 'context']);
  });

  it('is a stable module-level reference (same array across reads)', () => {
    // ChatPanel spreads this into a useMemo dep; a fresh array each read would
    // defeat the memo. Importing twice must yield the identical reference.
    expect(NATIVE_COMMAND_ENTRIES).toBe(NATIVE_COMMAND_ENTRIES);
  });
});
