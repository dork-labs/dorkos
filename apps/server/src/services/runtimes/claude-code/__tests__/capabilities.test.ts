/**
 * Snapshot-style tests that lock the shape of `CLAUDE_CODE_CAPABILITIES`.
 *
 * The client depends on the exact ids in `permissionModes.values` to render
 * the picker, and on the `features.*` flags to gate Claude-specific UI cues.
 * Any drift here would silently break the UI without a lint/type error, so
 * these tests exist to make drift visible at CI time.
 *
 * @see ../runtime-constants.ts
 */
import { describe, it, expect } from 'vitest';
import { CLAUDE_CODE_CAPABILITIES, narrowToClaudeCodeMode } from '../runtime-constants.js';

describe('CLAUDE_CODE_CAPABILITIES', () => {
  it('exposes the five Claude SDK permission modes DorkOS surfaces', () => {
    expect(CLAUDE_CODE_CAPABILITIES.permissionModes.supported).toBe(true);
    expect(CLAUDE_CODE_CAPABILITIES.permissionModes.values).toHaveLength(5);
    expect(CLAUDE_CODE_CAPABILITIES.permissionModes.values.map((v) => v.id)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
      'auto',
    ]);
  });

  it('provides id, label, and description for each permission mode descriptor', () => {
    for (const descriptor of CLAUDE_CODE_CAPABILITIES.permissionModes.values) {
      expect(descriptor.id).toBeTypeOf('string');
      expect(descriptor.id.length).toBeGreaterThan(0);
      expect(descriptor.label).toBeTypeOf('string');
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.description).toBeTypeOf('string');
      expect(descriptor.description!.length).toBeGreaterThan(0);
    }
  });

  it('declares Claude-specific UI feature flags consumers will gate on', () => {
    expect(CLAUDE_CODE_CAPABILITIES.features.claudeSkills).toBe(true);
    expect(CLAUDE_CODE_CAPABILITIES.features.claudeHooks).toBe(true);
    expect(CLAUDE_CODE_CAPABILITIES.features.claudeSlashCommands).toBe(true);
  });

  it('reports plugin support for the Claude-specific transport shaping', () => {
    expect(CLAUDE_CODE_CAPABILITIES.supportsPlugins).toBe(true);
  });

  it('declares no native context kinds (server injects all via the bag, ADR-0273 A2)', () => {
    expect(CLAUDE_CODE_CAPABILITIES.nativeContext).toEqual([]);
  });
});

describe('narrowToClaudeCodeMode (DOR-885)', () => {
  it('passes every mode this runtime declares through untouched', () => {
    // The five ids the picker offers are the five the SDK takes, so none of
    // them may be turned into something else on the way to a query.
    for (const descriptor of CLAUDE_CODE_CAPABILITIES.permissionModes.values) {
      expect(narrowToClaudeCodeMode(descriptor.id, 'default')).toBe(descriptor.id);
    }
  });

  it("passes 'dontAsk' through — the SDK takes it even though the picker hides it", () => {
    // The question this function answers is "will the SDK accept this id?", not
    // "does the picker offer it?". `dontAsk` is a real SDK mode DorkOS declines
    // to surface, and coercing it would be a change nobody asked for.
    expect(narrowToClaudeCodeMode('dontAsk', 'default')).toBe('dontAsk');
  });

  it('falls back for an id the SDK never heard of, rather than passing it on', () => {
    // `always-allow` is `test-mode`'s real declared default, and it can reach a
    // Claude Code session through the settings store, which is one plain text
    // column shared by every runtime. Sending it to the SDK fails the whole turn
    // with a 400; falling back to the caller's mode asks about everything.
    expect(narrowToClaudeCodeMode('always-allow', 'default')).toBe('default');
    expect(narrowToClaudeCodeMode('a-mode-nobody-declares', 'default')).toBe('default');
  });

  it('falls back when there is no id at all', () => {
    expect(narrowToClaudeCodeMode(undefined, 'default')).toBe('default');
  });
});
