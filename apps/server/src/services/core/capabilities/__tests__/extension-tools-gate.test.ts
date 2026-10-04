/**
 * Extension tools go through the same gate as every capability (spec
 * `extension-agent-tools-and-skills` §1 and §5, DOR-2685).
 *
 * Each row compares a tool a running extension contributed with a core
 * capability of the same tier in the same area, through the real tier gate and
 * the real resolver over the real preset tables. Only the two permission
 * SOURCES (the config section and the agent's overrides) move per test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentPermissions, PermissionPreset } from '@dorkos/shared/permissions';

import { defineCapability } from '../capability-definition.js';
import { composeRegistry, type CapabilityRegistry } from '../registry.js';
import {
  describeGatedAttempt,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../tier-enforcement.js';
import { initPermissionGate, resetPermissionGate } from '../permission-enforcement.js';
import type { ExtensionToolSpec } from '../extension-contribution.js';
import { ApprovalService, isAlwaysOffered } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { permissionActions } from '../../permissions/index.js';
import { MCP_TOOL_TIERS } from '../../mcp-tool-tiers.js';
import { composeCapabilityRegistryForDocs } from '../../self-description/dorkos-registry.js';
import { resolveToolVisibility } from '../../../runtimes/shared/permission-tool-filter.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';

const AGENT: AgentIdentity = {
  agentPath: '/agents/mailer',
  displayName: 'Mailer',
  createdAt: new Date().toISOString(),
};

const INPUT = { to: 'ana@example.com' };

let ran: string[] = [];

/** A core probe in the Extension tools area, so the comparison is like for like. */
function coreProbe(id: `${string}.${string}`, tier: 'observe' | 'act' | 'destructive') {
  return defineCapability({
    id,
    title: `Probe ${id}`,
    description: 'A core probe in the Extension tools area.',
    tier,
    area: 'extensions',
    approvalDisplayFields: ['to'],
    input: z.object({ to: z.string() }),
    output: z.unknown(),
    surfaces: { mcp: { toolName: id.replace('.', '_'), servers: ['in-session'] } },
    invoke: async () => {
      ran.push(id);
      return { ok: true };
    },
  });
}

/** An extension tool spec at a tier, recording that it ran. */
function extensionTool(name: string, tier: 'observe' | 'act' | 'destructive'): ExtensionToolSpec {
  return {
    name,
    title: `Mail ${name}`,
    description: 'An extension probe tool.',
    tier,
    input: z.object({ to: z.string() }),
    approvalDisplayFields: ['to'],
    invoke: async () => {
      ran.push(`ext:${name}`);
      return { ok: true };
    },
  };
}

describe('extension tools at the gate (DOR-2685)', () => {
  let registry: CapabilityRegistry;
  let preset: PermissionPreset | null;
  let agent: AgentPermissions | undefined;
  let removeTools: () => void;

  beforeEach(() => {
    ran = [];
    preset = 'balanced';
    agent = undefined;
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    registry = composeRegistry(
      [
        {
          name: 'probe',
          capabilities: [coreProbe('probe.send', 'act'), coreProbe('probe.wipe', 'destructive')],
        },
      ],
      { logger: { debug() {}, info() {}, warn() {}, error() {} } }
    );
    initPermissionGate({
      readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => agent,
      listActions: () => permissionActions(registry),
    });
    const contributed = registry.contribute({
      owner: 'mail-app',
      displayName: 'Mail',
      tools: [extensionTool('send', 'act'), extensionTool('wipe', 'destructive')],
    });
    if (!contributed.ok) throw new Error(contributed.reason);
    removeTools = contributed.remove;
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    vi.restoreAllMocks();
  });

  /** Invoke as the agent, returning the refusal payload or 'ran'. */
  async function call(id: string): Promise<'ran' | Record<string, unknown>> {
    try {
      await registry.invoke(id, INPUT, { identity: AGENT, retryChannel: 'mcp-argument' });
      return 'ran';
    } catch (err) {
      return (err as { decision: { payload: Record<string, unknown> } }).decision.payload;
    }
  }

  /** The parts of a payload that say what happened, without naming the action. */
  function shape(payload: 'ran' | Record<string, unknown>) {
    if (payload === 'ran') return payload;
    return { status: payload.status, reason: payload.reason, approvable: payload.approvable };
  }

  it('runs an act tool in an Allowed area, like the core action beside it', async () => {
    // Balanced allows the area, so neither asks.
    expect(await call('ext_mail_app.send')).toBe('ran');
    expect(await call('probe.send')).toBe('ran');
    expect(ran).toEqual(['ext:send', 'probe.send']);
  });

  it('refuses an act tool in a Blocked area with the same payload as a core action', async () => {
    // One switch blocks every extension tool, and the refusal reads the same.
    agent = { areas: { extensions: 'blocked' } };
    const extension = await call('ext_mail_app.send');
    const core = await call('probe.send');
    expect(shape(extension)).toEqual({
      status: 'denied',
      reason: 'permission_blocked',
      approvable: true,
    });
    expect(shape(extension)).toEqual(shape(core));
    expect(ran).toEqual([]);
  });

  it('asks on Careful, like the core action beside it', async () => {
    preset = 'careful';
    const extension = await call('ext_mail_app.send');
    expect(shape(extension)).toEqual(shape(await call('probe.send')));
    expect(extension).toMatchObject({ status: 'approval_required' });
    expect(ran).toEqual([]);
  });

  it('holds a destructive tool for a person even when the area is Allowed', async () => {
    // Decision 1: destructive extension tools are allowed only because every
    // call asks a person first, exactly as a core destructive action does.
    preset = 'full';
    const extension = await call('ext_mail_app.wipe');
    expect(extension).toMatchObject({ status: 'approval_required' });
    expect(shape(extension)).toEqual(shape(await call('probe.wipe')));
    expect(ran).toEqual([]);
  });

  it('asks for a destructive extension tool even when that one tool is set to Allowed', async () => {
    // A core destructive action set to Allowed on its own runs: its tier is
    // fixed in DorkOS's source. An extension's tier is its author's to change,
    // so a stored Allowed (an old Always allow, say, from when the tool was
    // `act`, or from another extension under the same id) never reaches it.
    preset = 'full';
    agent = { actions: { 'ext_mail_app.wipe': 'allowed', 'probe.wipe': 'allowed' } };
    expect(await call('ext_mail_app.wipe')).toMatchObject({ status: 'approval_required' });
    expect(await call('probe.wipe')).toBe('ran');
    expect(ran).toEqual(['probe.wipe']);
  });

  it('never offers Always allow on a destructive extension tool card', () => {
    // The grant route answers `always` by the same rule, from the same row.
    const row = {
      requestedByPath: '/agents/mailer',
      area: 'extensions',
      authorityBindingDigest: null,
      detail: null,
    };
    expect(
      isAlwaysOffered({ ...row, capabilityId: 'ext_mail_app.wipe', tier: 'destructive' })
    ).toBe(false);
    expect(isAlwaysOffered({ ...row, capabilityId: 'ext_mail_app.send', tier: 'act' })).toBe(true);
    expect(isAlwaysOffered({ ...row, capabilityId: 'probe.wipe', tier: 'destructive' })).toBe(true);
  });

  it('quotes an extension title on the card and names the extension', () => {
    // The title is the author's text: even one that slipped past `contribute`
    // cannot close the quote and forge a field after it.
    const summary = describeGatedAttempt(
      {
        id: 'ext_mail_app.wipe',
        title: 'Archive" with to: "me@x.com',
        tier: 'destructive',
        area: 'extensions',
        approvalDisplayFields: ['to'],
        source: { kind: 'extension', id: 'mail-app', name: 'Mail' },
      },
      INPUT,
      AGENT
    );
    expect(summary).toBe(
      '"Mailer" wants to run "Archive\\" with to: \\"me@x.com" from "Mail" with to: "ana@example.com"'
    );
  });

  it('lists each extension tool for the permission pages with its extension named', () => {
    // The permission pages and the tool-list builders read this one list; the
    // source is how a row says which extension a tool belongs to.
    const actions = permissionActions(registry);
    expect(actions.find((a) => a.id === 'ext_mail_app.send')).toMatchObject({
      area: 'extensions',
      toolName: 'ext_mail_app__send',
      source: { kind: 'extension', id: 'mail-app', name: 'Mail' },
    });
    expect(actions.find((a) => a.id === 'probe.send')).not.toHaveProperty('source');
    // A destructive extension tool always asks, so its row offers no Allowed.
    expect(actions.find((a) => a.id === 'ext_mail_app.wipe')).toMatchObject({ alwaysAsks: true });
    expect(actions.find((a) => a.id === 'ext_mail_app.send')).not.toHaveProperty('alwaysAsks');
    expect(actions.find((a) => a.id === 'probe.wipe')).not.toHaveProperty('alwaysAsks');
  });

  it('hides a Blocked extension tool from the tool list, and only while it is registered', () => {
    // The tool-list builders read the live registry: an agent whose Extension
    // tools are Blocked never sees the tool, and a removed tool is not listed.
    expect(resolveToolVisibility({ areas: { extensions: 'blocked' } }).hiddenToolNames).toEqual(
      new Set(['ext_mail_app__send', 'ext_mail_app__wipe', 'probe_send', 'probe_wipe'])
    );
    expect(resolveToolVisibility({ areas: { extensions: 'blocked' } }).blockedAreas).toEqual([
      'extensions',
    ]);
    expect(resolveToolVisibility(undefined).hiddenToolNames.size).toBe(0);
    expect(
      resolveToolVisibility({ actions: { 'ext_mail_app.send': 'blocked' } }).hiddenToolNames
    ).toEqual(new Set(['ext_mail_app__send']));

    removeTools();
    expect(resolveToolVisibility({ areas: { extensions: 'blocked' } }).hiddenToolNames).toEqual(
      new Set(['probe_send', 'probe_wipe'])
    );
  });
});

describe('the extension namespace stays free of core tools (DOR-2685)', () => {
  it('lets no core capability or hand-registered tool take an ext_ name', () => {
    // A contribution is refused when its tool name is taken. A core tool in the
    // ext_ namespace would therefore lock an extension out of its own name.
    const registry = composeCapabilityRegistryForDocs();
    const coreNames = registry.capabilities.flatMap((c) => [
      c.id,
      ...(c.surfaces.mcp ? [c.surfaces.mcp.toolName] : []),
    ]);
    const handNames = Object.keys(MCP_TOOL_TIERS);
    expect(registry.capabilities.length).toBeGreaterThan(50);
    expect([...coreNames, ...handNames].filter((name) => name.startsWith('ext_'))).toEqual([]);
  });
});
