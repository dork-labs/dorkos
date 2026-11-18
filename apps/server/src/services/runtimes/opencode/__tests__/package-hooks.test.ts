/**
 * DOR-4379 probe for OpenCode: an installed package's shell guard rejects a
 * matching `bash` ask in every mode, Full included, and says why. Real guard
 * processes; only the consent read is stubbed, to "this package is allowed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';
import type { ApprovalRouting } from '../messaging/approvals.js';
import {
  makeGuardProject,
  type GuardProject,
} from '../../shared/policy/__tests__/package-hook-fixture.js';

import { createOpencodeClient } from '@opencode-ai/sdk';
import {
  enforceApprovals,
  PendingApprovalStore,
  rejectPermissionWithReason,
} from '../messaging/approvals.js';
import { OpenCodeSessionRegistry } from '../sessions/session-registry.js';

let project: GuardProject;
beforeEach(() => {
  project = makeGuardProject();
  project.install([{ event: 'PreToolUse', matcher: 'Bash', command: project.guardCommand }]);
});
afterEach(() => project.cleanup());

const MODES = ['default', 'acceptEdits', 'bypassPermissions'] as const;
const BLOCKED = ['git stash', 'pkill -f vite'];

describe('OpenCode: shell guards', () => {
  function ask(command: string): StreamEvent {
    return {
      type: 'approval_required',
      data: {
        toolCallId: 'perm-1',
        toolName: 'bash',
        input: JSON.stringify({ patterns: [command], command }),
        timeoutMs: 1,
        startedAt: 1,
        hasSuggestions: false,
      },
    };
  }
  async function run(mode: string, event: StreamEvent, firstReply?: unknown) {
    const respond = vi.fn().mockResolvedValue({ data: true });
    if (firstReply !== undefined) respond.mockResolvedValueOnce(firstReply);
    const provider = {
      getClient: async () => ({ postSessionIdPermissionsPermissionId: respond }),
    } as unknown as OpenCodeClientProvider;
    const registry = new OpenCodeSessionRegistry();
    registry.register('oc-session', { permissionMode: mode });
    const turn: ApprovalRouting = {
      sessionId: 'oc-session',
      ocSessionId: 'ses_1',
      cwd: project.dir,
      permissions: { pendingPermissionSessions: new Map() },
    };
    const events: StreamEvent[] = [];
    for await (const out of enforceApprovals(
      { provider, registry, approvals: new PendingApprovalStore() },
      turn,
      event
    ))
      events.push(out);
    return { respond, events };
  }

  for (const mode of MODES) {
    it.each(BLOCKED)(`rejects %s in ${mode} and says why, to the model too`, async (command) => {
      const { respond, events } = await run(mode, ask(command));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'permission_denied',
        data: { toolCallId: 'perm-1', toolName: 'bash', reasonType: 'package_hook' },
      });
      const reason = (events[0]!.data as { reason: string }).reason;
      expect(reason).toMatch(/^Blocked: /);
      // DOR-4447: the reply route that carries a message, with the guard's own words.
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith({
        url: '/permission/{requestID}/reply',
        path: { requestID: 'perm-1' },
        body: { reply: 'reject', message: reason },
      });
    });
  }

  it('approves a non-matching command in Full', async () => {
    const { respond, events } = await run('bypassPermissions', ask('git status'));
    expect(respond).toHaveBeenCalledWith({
      path: { id: 'ses_1', permissionID: 'perm-1' },
      body: { response: 'once' },
    });
    expect(events).toEqual([]);
  });

  it('refuses a bash ask that names no command', async () => {
    const event = ask('');
    const { respond, events } = await run('bypassPermissions', event);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ reply: 'reject' }) })
    );
    expect(events[0]).toMatchObject({ type: 'permission_denied' });
  });

  it.each([
    ['refuses the reply route', { error: { name: 'NotFound' } }],
    ['answers it with anything but true', { data: {} }],
  ])('still rejects, without the reason, when the sidecar %s', async (_label, firstReply) => {
    const { respond, events } = await run('bypassPermissions', ask('git stash'), firstReply);
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenLastCalledWith({
      path: { id: 'ses_1', permissionID: 'perm-1' },
      body: { response: 'reject' },
    });
    expect(events[0]).toMatchObject({ type: 'permission_denied' });
  });

  it('fails closed when the guard crashes', async () => {
    project.install([
      { event: 'PreToolUse', matcher: 'Bash', command: `node -e "process.exit(3)"` },
    ]);
    const { respond, events } = await run('bypassPermissions', ask('git status'));
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ reply: 'reject' }) })
    );
    expect((events[0]!.data as { reason: string }).reason).toMatch(
      /^A safety check from example-guards failed with exit code 3/
    );
  });
});

describe('OpenCode: the reasoned reject on the wire (DOR-4447)', () => {
  it('posts the reason to /permission/{id}/reply through the real SDK client', async () => {
    const seen: Array<{ method: string; path: string; body: unknown }> = [];
    const fetch = vi.fn(async (request: Request) => {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: JSON.parse(await request.text()),
      });
      return new Response('true', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const client = createOpencodeClient({ baseUrl: 'http://127.0.0.1:9', fetch } as never);
    const provider = { getClient: async () => client } as unknown as OpenCodeClientProvider;
    await rejectPermissionWithReason(
      provider,
      { ocSessionId: 'ses_1', cwd: '/demo/projects/northwind' },
      'perm-1',
      'Blocked: git stash is not allowed here.'
    );
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/permission/perm-1/reply',
        body: { reply: 'reject', message: 'Blocked: git stash is not allowed here.' },
      },
    ]);
  });
});
