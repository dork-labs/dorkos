/**
 * Gate parity for tools a running extension contributes through `ctx.tools`
 * (DOR-2685, task 2.3).
 *
 * The registry-level parity is pinned in `extension-tools-gate.test.ts`; this
 * drives the same real gate with the tools built exactly as the lifecycle
 * builds them — discovery's check on the fixture manifest, `ctx.tools.handle`,
 * and the host-built invoke wrapper — so nothing on that path can loosen it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import type { AgentPermissions, PermissionPreset } from '@dorkos/shared/permissions';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { defineCapability } from '../../../core/capabilities/capability-definition.js';
import {
  composeRegistry,
  type CapabilityInvocationObserver,
  type CapabilityRegistry,
} from '../../../core/capabilities/registry.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../core/capabilities/permission-enforcement.js';
import { ApprovalService } from '../../../core/approvals/index.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { permissionActions } from '../../../core/permissions/index.js';
import type { AgentIdentity } from '../../../core/agent-identity/agent-identity-service.js';
import { checkDeclaredTools } from '@dorkos/extension-api/tool-check';
import { createToolBinding, RunningExtensionTools } from '../tool-binding.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../__fixtures__/agent-tools-ext/extension.json'
);

const AGENT: AgentIdentity = {
  agentPath: '/agents/mailer',
  displayName: 'Mailer',
  createdAt: new Date().toISOString(),
};

let ran: string[] = [];

/** A core probe in the Extension tools area, for a like-for-like comparison. */
const coreSend = defineCapability({
  id: 'probe.send',
  title: 'Probe send',
  description: 'A core act probe in the Extension tools area.',
  tier: 'act',
  area: 'extensions',
  approvalDisplayFields: ['by'],
  input: z.object({ by: z.number().optional() }),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'probe_send', servers: ['in-session'] } },
  invoke: async () => {
    ran.push('probe.send');
    return { ok: true };
  },
});

describe('ctx.tools tools at the gate', () => {
  let registry: CapabilityRegistry;
  let approvals: ApprovalService;
  let preset: PermissionPreset;
  let agent: AgentPermissions | undefined;
  let observed: Parameters<CapabilityInvocationObserver>[0][];

  beforeEach(() => {
    ran = [];
    observed = [];
    preset = 'balanced';
    agent = undefined;
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    approvals = new ApprovalService(createTestDb());
    initCapabilityTierGate({ approvals });
    registry = composeRegistry(
      [{ name: 'probe', capabilities: [coreSend] }],
      { logger: { debug() {}, info() {}, warn() {}, error() {} } },
      (event) => observed.push(event)
    );
    initPermissionGate({
      readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => agent,
      listActions: () => permissionActions(registry),
    });

    const manifest = ExtensionManifestSchema.parse(JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')));
    const checks = checkDeclaredTools(manifest);
    const binding = createToolBinding(manifest.id, checks);
    binding.api.handle('echo', (input) => input);
    binding.api.handle('bump_counter', () => {
      ran.push('ext:bump_counter');
      return { total: 1 };
    });
    binding.api.handle('delete_note', (input) => {
      ran.push('ext:delete_note');
      return { deleted: (input as { noteId: string }).noteId };
    });
    const { handled } = binding.seal();
    const running = new RunningExtensionTools(manifest.id, manifest.name, handled, []);
    expect(running.contribute(registry)).toBeUndefined();
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    vi.restoreAllMocks();
  });

  /** Invoke as the agent; the refusal payload, or the result. */
  async function call(
    id: string,
    input: unknown,
    approvalToken?: string
  ): Promise<{ ran: unknown } | Record<string, unknown>> {
    try {
      const result = await registry.invoke(id, input, {
        identity: AGENT,
        retryChannel: 'mcp-argument',
        ...(approvalToken ? { approvalToken } : {}),
      });
      return { ran: result };
    } catch (err) {
      return (err as { decision: { payload: Record<string, unknown> } }).decision.payload;
    }
  }

  it('refuses the act tool in a Blocked area exactly like a core act action', async () => {
    // Purpose: one switch blocks every extension tool, the refusal reads the
    // same as for DorkOS's own action, and the handler never runs.
    agent = { areas: { extensions: 'blocked' } };
    const extension = await call('ext_agent_tools_ext.bump_counter', { by: 2 });
    const core = await call('probe.send', { by: 2 });
    const shape = (p: Record<string, unknown>) => ({
      status: p.status,
      reason: p.reason,
      approvable: p.approvable,
    });
    expect(shape(extension)).toEqual({
      status: 'denied',
      reason: 'permission_blocked',
      approvable: true,
    });
    expect(shape(extension)).toEqual(shape(core));
    expect(ran).toEqual([]);
  });

  it('holds the destructive tool for a person, and runs it once with the granted token', async () => {
    // Purpose: Decision 1 — every destructive call waits for a person's yes,
    // bound to its input, and the yes then runs exactly that call.
    preset = 'full';
    const asked = await call('ext_agent_tools_ext.delete_note', { noteId: 'n-1' });
    expect(asked).toMatchObject({ status: 'approval_required' });
    expect(ran).toEqual([]);
    const { approvalId, approvalToken } = asked as { approvalId: string; approvalToken: string };
    expect(approvals.grant(approvalId)).toBeUndefined();
    const granted = await call('ext_agent_tools_ext.delete_note', { noteId: 'n-1' }, approvalToken);
    expect(granted).toEqual({ ran: { deleted: 'n-1' } });
    expect(ran).toEqual(['ext:delete_note']);
  });

  it('records the act call for Activity, attributed to the agent', async () => {
    // Purpose: an extension tool call leaves the same audit record as any
    // capability call.
    expect(await call('ext_agent_tools_ext.bump_counter', { by: 1 })).toEqual({
      ran: { total: 1 },
    });
    const event = observed.find((e) => e.capability.id === 'ext_agent_tools_ext.bump_counter');
    expect(event).toMatchObject({ ok: true });
    expect(event?.context.identity?.agentPath).toBe('/agents/mailer');
    expect(event?.capability.source).toEqual({
      kind: 'extension',
      id: 'agent-tools-ext',
      name: 'Agent Tools Fixture',
    });
  });
});
