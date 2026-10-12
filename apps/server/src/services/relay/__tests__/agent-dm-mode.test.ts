/**
 * The mode an agent DM's turn starts at on the answering agent (spec
 * `trusted-by-default-flip` §4.4): its own configured Files & commands stop, as
 * the answering runtime names it. The relay adapter holds the turn to the
 * sender's stamped level on top (`packages/relay` `agent-turn-ceiling.test.ts`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';

vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => ({ name: 'b' })) }));

import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../core/capabilities/permission-enforcement.js';
import { createAgentDmModeResolver } from '../agent-dm-mode.js';

/** A Claude Code profile with its real declared modes. */
function claudeCapabilities() {
  const runtime = new FakeAgentRuntime('claude-code');
  return {
    ...runtime.getCapabilities(),
    permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes,
    settings: CLAUDE_CODE_CAPABILITIES.settings,
  };
}

const resolve = createAgentDmModeResolver({
  capabilitiesOf: (type) => (type === 'claude-code' ? claudeCapabilities() : undefined),
});

/** The answering agent's own stop, as the permission gate reads it. */
function agentStopIs(stop: PermissionStop | undefined) {
  initPermissionGate({
    readAgentPermissions: async () => (stop ? { filesAndCommands: stop } : undefined),
  });
}

afterEach(() => resetPermissionGate());

describe('createAgentDmModeResolver', () => {
  it.each([
    ['autonomy', 'bypassPermissions'],
    ['act', 'acceptEdits'],
    ['ask', 'default'],
  ] as const)("names the answering agent's %s stop as %s", async (stop, mode) => {
    agentStopIs(stop);
    expect(await resolve({ agentDirectory: '/agents/b', runtimeType: 'claude-code' })).toBe(mode);
  });

  it('answers nothing for a runtime that is not registered', async () => {
    agentStopIs('autonomy');
    expect(await resolve({ agentDirectory: '/agents/b', runtimeType: 'ghost' })).toBeUndefined();
  });

  it('answers nothing when no stop is configured anywhere', async () => {
    agentStopIs(undefined);
    expect(
      await resolve({ agentDirectory: '/agents/b', runtimeType: 'claude-code' })
    ).toBeUndefined();
  });
});
