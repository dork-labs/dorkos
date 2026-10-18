/**
 * The bridge's outsider cap reaches every reader of the outsider rule, and a
 * calm session record cannot lift it at any of them (DOR-2939 part 6): the
 * permission gate, `memory_write`, the `session_start` ceiling and the
 * destructive hold window all read `outsiderBoundOf` with the caller.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  lastTurnLevelOf,
  outsiderBoundOf,
  recordTurnLevels,
} from '../../turn-power/turn-levels.js';
import {
  holdRequesterFor,
  strangerTurnOf,
} from '../../../connectors/execution/destructive-hold-window.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';

const AGENT = '/hub/agents/scout';

/** Record a calm turn on `sessionId`: one that never asks and read no outsider's words. */
async function recordCalmTurn(sessionId: string): Promise<void> {
  const runtime = {
    getCapabilities: () => ({
      permissionModes: {
        default: 'auto-yes',
        values: [{ id: 'auto-yes', asks: 'never', reach: 'write' }],
      },
    }),
    sendMessage: async function* () {},
  } as unknown as AgentRuntime;
  for await (const _ of recordTurnLevels(runtime, () => 'auto-yes').sendMessage(sessionId, 'hi')) {
    // no events
  }
  expect(lastTurnLevelOf(sessionId)).toMatchObject({ asks: 'never' });
  expect(lastTurnLevelOf(sessionId)?.outsider).toBeUndefined();
}

describe('the one rule', () => {
  it('binds a capped caller whatever a calm session record says, and leaves others alone', async () => {
    await recordCalmTurn('calm-1');
    expect(outsiderBoundOf('calm-1', { agentPath: AGENT })).toBeUndefined();
    expect(outsiderBoundOf('calm-1', { agentPath: AGENT, outsiderCapped: true })).toMatchObject({
      outsider: true,
      asks: 'never',
    });
    // With no record at all, the bound a stranger's message carries.
    expect(outsiderBoundOf('none', { agentPath: AGENT, outsiderCapped: true })).toBe(
      'runtime-default'
    );
    expect(outsiderBoundOf('none', { agentPath: AGENT })).toBeUndefined();
  });
});

describe('the destructive hold window', () => {
  const identity: AgentIdentity = { agentPath: AGENT, displayName: 'Scout', createdAt: 'now' };
  const sources = {
    trusted: () => true,
    describeAgent: async () => identity,
    turnLevel: lastTurnLevelOf,
    strangerTurn: strangerTurnOf,
  };
  const context = (sessionId: string, over: Partial<AgentIdentity> = {}) => ({
    identity: { ...identity, ...over },
    serverPrincipal: createServerPrincipal({
      kind: 'runtime',
      owner: { kind: 'local_install', installationId: 'inst' },
      bindingId: 'b1',
      runtime: 'opencode',
      canonicalSessionId: sessionId,
      agentId: '01KJXYKJYW4N8QGQ5W4GB6YM9J',
      agentPath: AGENT,
    }),
  });
  const preflight = { approvalServiceAction: { kind: 'x' } } as never;

  it('holds a calm turn`s call, but never a capped one, even read fresh', async () => {
    await recordCalmTurn('calm-2');
    expect(await holdRequesterFor(context('calm-2'), preflight, sources)).toBeDefined();
    const capped = context('calm-2', { outsiderCapped: true });
    expect(await holdRequesterFor(capped, preflight, sources)).toBeUndefined();
    expect(await holdRequesterFor(capped, preflight, sources, true)).toBeUndefined();
  });
});

describe('every reader', () => {
  const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const READERS = [
    'services/core/capabilities/permission-enforcement.ts',
    'services/memory/memory-capabilities.ts',
    'services/runtimes/claude-code/mcp-tools/session-tools.ts',
    'services/connectors/execution/destructive-hold-window.ts',
  ];

  it('hands the rule the caller, never only a path that would drop the cap', () => {
    for (const file of READERS) {
      const text = fs.readFileSync(path.join(serverSrc, file), 'utf8');
      const calls = [...text.matchAll(/outsiderBoundOf\(([^;]*?)\)/g)].map((m) => m[1]!);
      expect(calls.length, file).toBeGreaterThan(0);
      for (const args of calls) expect(args, file).not.toMatch(/agentPath\s*$/);
    }
  });

  it('carries the cap from the identity into the session_start caller', () => {
    const external = fs.readFileSync(
      path.join(serverSrc, 'services/core/external-mcp/session-tools.ts'),
      'utf8'
    );
    expect(external).toMatch(/identity\.outsiderCapped \? \{ outsiderCapped: true \}/);
  });
});
