/**
 * DorkOS's own tools that hand an agent someone else's text mark the turn that called them
 * (DOR-3969, spec §4.7, Security's Addition A), on both paths a DorkOS tool runs by: the capability
 * registry, and the hand-registered tool gate.
 *
 * The census is the part that keeps this true: every tool an agent can reach is classed in
 * `DORKOS_TOOL_READS`, so a new tool fails here until someone decides whether it returns outside
 * text. A tool the table does not know marks (an extension's tool), which is the safe side.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { composeCapabilityRegistryForDocs } from '../../self-description/dorkos-registry.js';
import { MCP_TOOL_TIERS } from '../../mcp-tool-tiers.js';
import { gateHandRegisteredMcpTools } from '../../mcp-tool-gate.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { defineCapability } from '../capability-definition.js';
import { composeRegistry } from '../registry.js';
import { initCapabilityTierGate, resetCapabilityTierGate } from '../tier-enforcement.js';
import { initPermissionGate, resetPermissionGate } from '../permission-enforcement.js';
import { DORKOS_TOOL_READS, dorkosToolReadOf } from '../dorkos-tool-reads.js';
import { marksOf, recordTurnLevels } from '../../turn-power/turn-levels.js';
import { marksHold } from '../../turn-power/turn-marks.js';
import { resetChosenTurns } from '../../turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../turn-power/live-outsider-turns.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';

const AGENT = {
  agentPath: '/agents/wren',
  displayName: 'Wren',
  createdAt: '2026-11-17T12:00:00.000Z',
};

let counter = 0;
const fresh = () => `dorkos-tool-reads-${(counter += 1)}`;
const held = (chat: string) => marksHold(marksOf(chat, AGENT.agentPath));

/** Run one turn in a chat set to Full autonomy, so its level is recorded. */
async function ranAtFull(sessionId: string) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
}

describe('the census: every DorkOS tool is classed', () => {
  const reachable = () => [
    ...composeCapabilityRegistryForDocs().capabilities.map((capability) => capability.id),
    ...Object.keys(MCP_TOOL_TIERS),
  ];

  it('names every capability and hand-registered tool an agent can reach', () => {
    const unclassed = reachable().filter((name) => !Object.hasOwn(DORKOS_TOOL_READS, name));
    expect(
      unclassed,
      'Class each new tool in DORKOS_TOOL_READS: does what it returns hold text from outside the team?'
    ).toEqual([]);
  });

  it('names nothing that no longer exists', () => {
    const names = new Set(reachable());
    expect(Object.keys(DORKOS_TOOL_READS).filter((name) => !names.has(name))).toEqual([]);
  });

  it('marks a tool nobody classed', () => {
    expect(dorkosToolReadOf('ext_garden.fetch_forecast')).toBe('outside');
  });
});

describe('a DorkOS tool that returns outside text marks the turn', () => {
  beforeEach(() => {
    resetChosenTurns();
    resetLiveOutsiderTurns();
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    resetChosenTurns();
    resetLiveOutsiderTurns();
    vi.restoreAllMocks();
  });

  describe('through the capability registry', () => {
    /** A capability under a real tool's id, with a stand-in handler: only the marking is under test. */
    const probe = (id: `${string}.${string}`, toolName: string) =>
      defineCapability({
        id,
        title: 'Probe',
        description: 'A stand-in handler under a real id.',
        tier: 'observe',
        area: null,
        input: z.object({}),
        output: z.unknown(),
        surfaces: { mcp: { toolName, servers: ['in-session'] } },
        invoke: async () => ({ text: 'made up' }),
      });
    const registry = () =>
      composeRegistry(
        [
          { name: 'ui', capabilities: [probe('ui.read_page', 'p1'), probe('ui.state', 'p2')] },
          { name: 'probe', capabilities: [probe('probe.unclassed', 'p3')] },
        ],
        { logger: { debug() {}, info() {}, warn() {}, error() {} } }
      );
    const asAgent = (sessionId: string) => ({
      identity: AGENT,
      sessionId,
      mcpServer: 'in-session' as const,
      retryChannel: 'mcp-argument' as const,
    });

    it('marks the turn that read a page', async () => {
      const chat = fresh();
      await ranAtFull(chat);
      await registry().invoke('ui.read_page', {}, asAgent(chat));
      expect(held(chat)).toBe(true);
    });

    it('marks the turn that called a tool nobody classed', async () => {
      const chat = fresh();
      await ranAtFull(chat);
      await registry().invoke('probe.unclassed', {}, asAgent(chat));
      expect(held(chat)).toBe(true);
    });

    it('leaves a turn that called only a local tool clean', async () => {
      const chat = fresh();
      await ranAtFull(chat);
      await registry().invoke('ui.state', {}, asAgent(chat));
      expect(held(chat)).toBe(false);
    });

    it("never marks a chat for a person's own call on the API", async () => {
      const chat = fresh();
      await ranAtFull(chat);
      await registry().invoke('ui.read_page', {}, { sessionId: chat, retryChannel: 'http-header' });
      expect(held(chat)).toBe(false);
    });
  });

  describe('through the hand-registered tool gate', () => {
    const tool = (name: string) =>
      gateHandRegisteredMcpTools(
        [
          {
            name,
            description: 'probe',
            inputSchema: {},
            handler: async () => ({ content: [{ type: 'text' as const, text: '{}' }] }),
          },
        ],
        async () => ({ identity: AGENT }),
        undefined,
        () => ({ sessionId: chatInUse })
      )[0]!;
    let chatInUse = '';

    it('marks the turn that read a message trace', async () => {
      chatInUse = fresh();
      await ranAtFull(chatInUse);
      await (tool('relay_get_trace').handler as (a: unknown, b: unknown) => Promise<unknown>)(
        {},
        {}
      );
      expect(held(chatInUse)).toBe(true);
    });

    it("leaves a turn that read only the bus's counts clean", async () => {
      chatInUse = fresh();
      await ranAtFull(chatInUse);
      await (tool('relay_get_metrics').handler as (a: unknown, b: unknown) => Promise<unknown>)(
        {},
        {}
      );
      expect(held(chatInUse)).toBe(false);
    });
  });
});
