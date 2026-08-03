/**
 * The client's one lookup for "where does this runtime keep its settings?".
 *
 * The behaviour worth pinning is the absences. This selector replaced a
 * hand-kept copy of the server's config-section map, and every caller writes
 * config off its answer — so each way of not knowing has to answer `undefined`
 * rather than a plausible-looking key nothing reads.
 */
import { describe, it, expect } from 'vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { settingsForRuntime } from '../lib/settings-for-runtime';

/** A runtime that declares a settings surface, as every shipped adapter does. */
const CLAUDE_CODE = {
  type: 'claude-code',
  settings: {
    configSection: 'claudeCode',
    supportsEffort: true,
    sections: [{ kind: 'claude-accounts' }],
  },
} as unknown as RuntimeCapabilities;

/** A real runtime with no config section at all — `test-mode` is the live one. */
const TEST_MODE = {
  type: 'test-mode',
  settings: { configSection: null, supportsEffort: false, sections: [] },
} as unknown as RuntimeCapabilities;

const MAP = { capabilities: { 'claude-code': CLAUDE_CODE, 'test-mode': TEST_MODE } };

describe('settingsForRuntime', () => {
  it('answers with the runtime’s own declaration', () => {
    expect(settingsForRuntime(MAP, 'claude-code')).toEqual({
      configSection: 'claudeCode',
      supportsEffort: true,
      sections: [{ kind: 'claude-accounts' }],
    });
  });

  it('carries a declared absence of a config section through, rather than inventing one', () => {
    // `test-mode` is registered and has answered; its answer is "no section".
    expect(settingsForRuntime(MAP, 'test-mode')?.configSection).toBeNull();
  });

  it('says undefined for a runtime this server has not registered', () => {
    expect(settingsForRuntime(MAP, 'aider')).toBeUndefined();
  });

  it('says undefined while the capability map has not loaded', () => {
    expect(settingsForRuntime(undefined, 'claude-code')).toBeUndefined();
  });

  it('says undefined for a session that has not bound to a runtime yet', () => {
    expect(settingsForRuntime(MAP, null)).toBeUndefined();
    expect(settingsForRuntime(MAP, undefined)).toBeUndefined();
    // The empty string is the same absence wearing a different spelling, and it
    // must not index the map.
    expect(settingsForRuntime(MAP, '')).toBeUndefined();
  });

  it('survives a capability object that carries no settings at all', () => {
    // Not reachable through a typed adapter — `settings` is required — but the
    // map arrives over the wire, and an older server is exactly the caller that
    // would omit it.
    const partial = { capabilities: { legacy: { type: 'legacy' } as RuntimeCapabilities } };
    expect(settingsForRuntime(partial, 'legacy')).toBeUndefined();
  });
});
