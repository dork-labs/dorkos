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
  REASON_REPLY_TIMEOUT_MS,
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
      directory: project.dir,
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
      // DOR-4447: the reply route that carries a message, with the guard's own words,
      // in the session's own folder (DOR-5248).
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith({
        url: '/permission/{requestID}/reply',
        path: { requestID: 'perm-1' },
        query: { directory: project.dir },
        body: { reply: 'reject', message: reason },
        signal: expect.any(AbortSignal),
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
  const target = {
    ocSessionId: 'ses_1',
    cwd: '/demo/projects/northwind',
    directory: '/demo/projects/northwind',
  };

  it('posts the reason to /permission/{id}/reply in the session folder, through the real SDK client', async () => {
    const seen: Array<{ method: string; path: string; body: unknown }> = [];
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        body: JSON.parse(await request.text()),
      });
      return new Response('true', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const client = createOpencodeClient({ baseUrl: 'http://127.0.0.1:9', fetch } as never);
    const provider = { getClient: async () => client } as unknown as OpenCodeClientProvider;
    await rejectPermissionWithReason(
      provider,
      target,
      'perm-1',
      'Blocked: git stash is not allowed here.'
    );
    // No session in this route's path: without the folder, OpenCode looks for the
    // ask in the folder the sidecar started in, and finds nothing (DOR-5248).
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/permission/perm-1/reply?directory=%2Fdemo%2Fprojects%2Fnorthwind',
        body: { reply: 'reject', message: 'Blocked: git stash is not allowed here.' },
      },
    ]);
  });

  it('rejects plainly once the reason route has not answered in time', async () => {
    vi.useFakeTimers();
    try {
      let reasonSignal: AbortSignal | undefined;
      const respond = vi.fn((options: { url?: string; signal?: AbortSignal }) => {
        if (options.url === undefined) return Promise.resolve({ data: true });
        reasonSignal = options.signal;
        return new Promise(() => {}); // a sidecar that never answers
      });
      const provider = {
        getClient: async () => ({ postSessionIdPermissionsPermissionId: respond }),
      } as unknown as OpenCodeClientProvider;
      let done = false;
      const refused = rejectPermissionWithReason(provider, target, 'perm-1', 'Blocked.').then(
        () => (done = true)
      );

      await vi.advanceTimersByTimeAsync(REASON_REPLY_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      expect(respond).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await refused;
      expect(reasonSignal?.aborted).toBe(true);
      expect(respond).toHaveBeenCalledTimes(2);
      expect(respond).toHaveBeenLastCalledWith({
        path: { id: 'ses_1', permissionID: 'perm-1' },
        body: { response: 'reject' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
