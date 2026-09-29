/**
 * `supportsAccounts` (spec `claude-account-fleet` §6 R): only a runtime with an
 * account registry declares it, and the account chip, dots and badge are gated
 * on it. Claude Code is the only one today.
 */
import { describe, it, expect } from 'vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { CLAUDE_CODE_CAPABILITIES } from '../claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../opencode/runtime-constants.js';
import { TEST_MODE_CAPABILITIES } from '../test-mode/runtime-constants.js';

describe('RuntimeCapabilities.supportsAccounts', () => {
  it.each<[string, RuntimeCapabilities, boolean]>([
    ['claude-code', CLAUDE_CODE_CAPABILITIES, true],
    ['codex', CODEX_CAPABILITIES, false],
    ['opencode', OPENCODE_CAPABILITIES, false],
    ['test-mode', TEST_MODE_CAPABILITIES, false],
  ])('%s declares %s', (_runtime, capabilities, expected) => {
    expect(capabilities.supportsAccounts).toBe(expected);
  });
});
