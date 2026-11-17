/**
 * `operator.update_agent_config` (DOR-4266): one agent writes one setup file under another
 * agent's `.claude/` folder through DorkOS, so a hook, a setting or a skill no longer needs a
 * person at a terminal.
 *
 * These drive the REAL operator domain through the REAL registry, permission gate and MCP
 * adapter, against a REAL agent folder on disk, and pin:
 *
 * - it asks by default, with the WHOLE file on the card (a hook file runs past the 80-character
 *   sentence clamp and past the old 4,000-character detail bound alike);
 * - Allowed on this action runs it with no card, and a Blocked area refuses it;
 * - a path outside the target's `.claude/` folder is refused before any card, and so is a turn
 *   that read words DorkOS can't vouch for;
 * - a `.claude/` that is a link to somewhere else is refused, even after a yes.
 *
 * The disk assertions are the load-bearing ones.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, realpath, stat, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentPermissions, PermissionOverrides } from '@dorkos/shared/permissions';
import { CARRIED_OUTSIDER_LEVEL } from '@dorkos/shared/permission-semantics';

import { operatorDomain } from '../operator-capabilities.js';
import {
  composeRegistry,
  initCapabilityTierGate,
  initPermissionGate,
  resetCapabilityTierGate,
  resetPermissionGate,
  type CapabilityRegistry,
} from '../../capabilities/index.js';
import { invokeCapabilityAsMcpResult } from '../../capabilities/mcp-projection.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { recordTurnLevels } from '../../turn-power/turn-levels.js';
import { resetLiveOutsiderTurns } from '../../turn-power/live-outsider-turns.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { initBoundary } from '../../../../lib/boundary.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { AgentIdentity } from '../../agent-identity/index.js';

const ID = 'operator.update_agent_config';

/** The agent doing the asking: not the one whose folder is written. */
const CALLER: AgentIdentity = {
  agentPath: '/projects/foreman',
  displayName: 'Foreman',
  createdAt: new Date().toISOString(),
};

const SEED = {
  id: '01M054RMQAMZPXHWHRKPGY9Z87',
  name: 'scribe',
  displayName: 'Scribe',
  description: 'Writes the newsletter.',
  runtime: 'claude-code',
  capabilities: ['writing'],
  behavior: { responseMode: 'always' },
  registeredAt: '2026-08-16T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  isSystem: false,
  mcpServers: [],
} as unknown as AgentManifest;

/** A hook longer than the old 4,000-character card bound, as the real one is. */
const LONG_HOOK = `#!/usr/bin/env python3\n${'# guard line\n'.repeat(500)}print("ok")\n`;

let root: string;
let agentPath: string;
let registry: CapabilityRegistry;
let approvals: ApprovalService;
let defaults: PermissionOverrides;
let own: AgentPermissions | undefined;
let counter = 0;

/** Invoke the capability the way an in-session MCP client would. */
async function callTool(
  args: Record<string, unknown>,
  sessionId?: string
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  const result = await invokeCapabilityAsMcpResult(registry, ID, args, {
    identity: CALLER,
    ...(sessionId ? { sessionId } : {}),
  });
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('expected a text content block');
  return {
    payload: JSON.parse(block.text) as Record<string, unknown>,
    isError: result.isError === true,
  };
}

/** Run one turn on `sessionId` that read an outsider's words. */
async function outsiderTurn(sessionId: string, opts: MessageOpts): Promise<void> {
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
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agent-config-')));
  agentPath = join(root, 'scribe');
  await mkdir(join(agentPath, '.dork'), { recursive: true });
  await writeManifest(agentPath, SEED);
  await initBoundary(root);

  registry = composeRegistry([operatorDomain], {
    logger: noopLogger,
    operatorDeps: {} as McpToolDeps,
  });
  approvals = new ApprovalService(createTestDb());
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals });
  defaults = { areas: {}, actions: {} };
  own = undefined;
  initPermissionGate({
    readConfig: () => ({ preset: 'full', defaults }),
    readAgentPermissions: async () => own,
  });
});

afterEach(async () => {
  resetCapabilityTierGate();
  resetPermissionGate();
  resetLiveOutsiderTurns();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('writing another agent’s setup file', () => {
  it('asks first, with the whole file on the card, and writes nothing yet', async () => {
    const { payload } = await callTool({
      cwd: agentPath,
      path: 'hooks/shell-guard.py',
      content: LONG_HOOK,
    });

    expect(payload.status).toBe('approval_required');
    expect(payload.tier).toBe('destructive');
    const [pending] = approvals.listPending();
    expect(pending).toMatchObject({ area: 'agents' });
    expect(pending!.summary).toContain('hooks/shell-guard.py');
    expect(LONG_HOOK.length).toBeGreaterThan(4000);
    expect(pending!.detail).toBe(LONG_HOOK);
    expect(existsSync(join(agentPath, '.claude', 'hooks', 'shell-guard.py'))).toBe(false);
  });

  it('writes it once a person says yes, making the folders it needs', async () => {
    const args = { cwd: agentPath, path: 'hooks/shell-guard.py', content: LONG_HOOK };
    const { payload } = await callTool(args);
    approvals.grant(String(payload.approvalId));

    const granted = await callTool({ ...args, approvalToken: payload.approvalToken });

    expect(granted.isError).toBe(false);
    expect(granted.payload).toMatchObject({ path: '.claude/hooks/shell-guard.py' });
    const written = join(agentPath, '.claude', 'hooks', 'shell-guard.py');
    expect(await readFile(written, 'utf8')).toBe(LONG_HOOK);
    // Not executable unless asked.
    expect((await stat(written)).mode & 0o111).toBe(0);
  });

  it('runs with no card when this action is Allowed, and can mark a hook executable', async () => {
    own = { actions: { [ID]: 'allowed' } };
    const { payload, isError } = await callTool({
      cwd: agentPath,
      path: 'hooks/guard.sh',
      content: '#!/bin/sh\nexit 0\n',
      executable: true,
    });

    expect(isError).toBe(false);
    expect(payload.status).toBeUndefined();
    expect(approvals.listPending()).toEqual([]);
    const written = join(agentPath, '.claude', 'hooks', 'guard.sh');
    expect(await readFile(written, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect((await stat(written)).mode & 0o100).toBe(0o100);
  });

  it('replaces a file that is already there', async () => {
    own = { actions: { [ID]: 'allowed' } };
    await callTool({ cwd: agentPath, path: 'settings.json', content: '{"a":1}' });
    await callTool({ cwd: agentPath, path: 'settings.json', content: '{"a":2}' });
    expect(await readFile(join(agentPath, '.claude', 'settings.json'), 'utf8')).toBe('{"a":2}');
  });

  it('refuses a settings file that is not valid JSON, before anything is written', async () => {
    own = { actions: { [ID]: 'allowed' } };
    const { payload, isError } = await callTool({
      cwd: agentPath,
      path: 'settings.json',
      content: '{ not json',
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('VALIDATION');
    expect(existsSync(join(agentPath, '.claude', 'settings.json'))).toBe(false);
  });

  it('refuses with no card when Other agents is Blocked', async () => {
    defaults = { areas: { agents: 'blocked' }, actions: {} };
    const { payload } = await callTool({ cwd: agentPath, path: 'settings.json', content: '{}' });
    expect(JSON.stringify(payload)).toContain('permission_blocked');
    expect(approvals.listPending()).toEqual([]);
    expect(existsSync(join(agentPath, '.claude', 'settings.json'))).toBe(false);
  });

  it('refuses a folder that holds no agent', async () => {
    own = { actions: { [ID]: 'allowed' } };
    const empty = join(root, 'nobody');
    await mkdir(empty);
    const { payload, isError } = await callTool({
      cwd: empty,
      path: 'settings.json',
      content: '{}',
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('NOT_FOUND');
    expect(existsSync(join(empty, '.claude'))).toBe(false);
  });
});

describe('only inside the target agent’s .claude folder', () => {
  it.each([
    ['a parent hop', '../outside.txt'],
    ['a hop out of a subfolder', 'hooks/../../outside.txt'],
    ['an absolute path', '/tmp/outside.txt'],
    ['the folder itself', '.'],
    ['an empty path', ''],
    ['a Windows separator', 'hooks\\..\\..\\outside.txt'],
    ['a NUL byte', 'hooks/a\u0000b'],
  ])('refuses %s before any card', async (_label, path) => {
    const { payload } = await callTool({ cwd: agentPath, path, content: 'x' });
    expect(payload.status).not.toBe('approval_required');
    expect(JSON.stringify(payload)).toMatch(/permission_blocked|VALIDATION/);
    expect(approvals.listPending()).toEqual([]);
    expect(existsSync(join(agentPath, 'outside.txt'))).toBe(false);
    expect(existsSync(join(root, 'outside.txt'))).toBe(false);
  });

  it('refuses a .claude folder that is a link to somewhere else, even with a yes', async () => {
    own = { actions: { [ID]: 'allowed' } };
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, join(agentPath, '.claude'));

    const { payload, isError } = await callTool({
      cwd: agentPath,
      path: 'settings.json',
      content: '{}',
    });

    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_AGENT_CONFIG');
    expect(existsSync(join(elsewhere, 'settings.json'))).toBe(false);
  });

  it('refuses a subfolder that is a link out of .claude', async () => {
    own = { actions: { [ID]: 'allowed' } };
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await mkdir(join(agentPath, '.claude'));
    await symlink(elsewhere, join(agentPath, '.claude', 'hooks'));

    const { payload, isError } = await callTool({
      cwd: agentPath,
      path: 'hooks/guard.sh',
      content: 'x',
    });

    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_AGENT_CONFIG');
    expect(existsSync(join(elsewhere, 'guard.sh'))).toBe(false);
  });

  it('refuses to write through a file that is a link', async () => {
    own = { actions: { [ID]: 'allowed' } };
    const target = join(root, 'victim.txt');
    await mkdir(join(agentPath, '.claude'));
    await symlink(target, join(agentPath, '.claude', 'settings.json'));

    const { isError, payload } = await callTool({
      cwd: agentPath,
      path: 'settings.json',
      content: '{}',
    });

    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_AGENT_CONFIG');
    expect(existsSync(target)).toBe(false);
  });
});

describe('a turn that read words DorkOS can’t vouch for', () => {
  it('is refused before any card, even with this action Allowed', async () => {
    own = { actions: { [ID]: 'allowed' } };
    const sessionId = `agent-config-outsider-${(counter += 1)}`;
    await outsiderTurn(sessionId, { permissionCeiling: CARRIED_OUTSIDER_LEVEL });

    const { payload } = await callTool(
      { cwd: agentPath, path: 'settings.json', content: '{}' },
      sessionId
    );

    expect(payload.status).not.toBe('approval_required');
    expect(JSON.stringify(payload)).toContain('permission_blocked');
    expect(approvals.listPending()).toEqual([]);
    expect(existsSync(join(agentPath, '.claude', 'settings.json'))).toBe(false);
  });
});
