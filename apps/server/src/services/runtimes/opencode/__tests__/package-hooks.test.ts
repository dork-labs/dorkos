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

import { enforceApprovals, PendingApprovalStore } from '../messaging/approvals.js';
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
  async function run(mode: string, event: StreamEvent) {
    const respond = vi.fn().mockResolvedValue({ data: true });
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
    it.each(BLOCKED)(`rejects %s in ${mode} and says why`, async (command) => {
      const { respond, events } = await run(mode, ask(command));
      expect(respond).toHaveBeenCalledWith({
        path: { id: 'ses_1', permissionID: 'perm-1' },
        body: { response: 'reject' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'permission_denied',
        data: { toolCallId: 'perm-1', toolName: 'bash', reasonType: 'package_hook' },
      });
      expect((events[0]!.data as { reason: string }).reason).toMatch(/^Blocked: /);
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
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ body: { response: 'reject' } }));
    expect(events[0]).toMatchObject({ type: 'permission_denied' });
  });

  it('fails closed when the guard crashes', async () => {
    project.install([
      { event: 'PreToolUse', matcher: 'Bash', command: `node -e "process.exit(3)"` },
    ]);
    const { respond, events } = await run('bypassPermissions', ask('git status'));
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ body: { response: 'reject' } }));
    expect((events[0]!.data as { reason: string }).reason).toMatch(
      /^A safety check from example-guards failed with exit code 3/
    );
  });
});
