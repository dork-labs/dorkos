/**
 * Tests for `dorkos permissions` and `dorkos agent permissions`
 * (`commands/permissions.ts`): each subcommand sends the right request with
 * `surface: 'cli'`, and a refusal prints the server's own sentence plus, for the
 * Full autonomy acknowledgement, the terminal's next step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api-client.js', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public body: { error?: string; code?: string }
    ) {
      super(body.error ?? `HTTP ${status}`);
    }
  }
  return { ApiError, apiCall: vi.fn() };
});

import { ApiError, apiCall } from '../../lib/api-client.js';
import { runAgentPermissions, runPermissionsDispatcher } from '../permissions.js';

const apiCallMock = vi.mocked(apiCall);
let logSpy: { mock: { calls: unknown[][] } };
let errorSpy: { mock: { calls: unknown[][] } };

const OVERVIEW = {
  preset: 'full',
  defaults: { areas: { rooms: 'ask' }, actions: {} },
  changeCount: 1,
  filesAndCommands: {
    stop: 'autonomy',
    presetStop: 'autonomy',
    runtimes: [],
    exceptions: [],
    followingAgentIds: ['a1', 'a2'],
  },
  areas: [
    {
      id: 'rooms',
      label: 'Rooms',
      description: '',
      floor: false,
      kind: 'state',
      actions: [],
      resolved: { state: 'ask', source: 'default-area', layer: 'default' },
    },
    {
      id: 'tasks',
      label: 'Tasks & schedules',
      description: '',
      floor: false,
      kind: 'state',
      actions: [{ id: 'tasks_delete', title: 'Delete a schedule', tier: 'destructive' }],
      resolved: { state: 'ask', source: 'preset', layer: 'default' },
    },
  ],
  exceptions: [{ agentId: 'a1', agentName: 'auditor', area: 'rooms', state: 'blocked' }],
  agentCount: 2,
};

const ROSTER = {
  agents: [
    { id: 'a1', name: 'security-auditor', displayName: 'Auditor' },
    { id: 'a2', name: 'dorkbot' },
  ],
};

const ACK_REFUSAL = new ApiError(428, {
  error:
    'Full autonomy lets agents edit files and run commands without asking. Confirm that in the app first, then try again.',
  code: 'AUTONOMY_ACK_REQUIRED',
});

/** Everything written to stdout/stderr, joined. */
const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const err = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('dorkos permissions', () => {
  it('lists the preset, its changes, each area and who differs', async () => {
    apiCallMock.mockResolvedValue(OVERVIEW);
    expect(await runPermissionsDispatcher([])).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/permissions');
    expect(out()).toContain('Preset: Full power, 1 change');
    expect(out()).toContain('Files & commands: Full autonomy');
    expect(out()).toMatch(/Rooms\s+rooms\s+Ask\s+Changed from your preset/);
    expect(out()).toMatch(/auditor\s+rooms\s+Blocked/);
  });

  it('sets an area for everyone', async () => {
    apiCallMock.mockResolvedValue({ changes: [], permissions: OVERVIEW });
    expect(await runPermissionsDispatcher(['set', 'rooms', 'ask'])).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('PATCH', '/api/permissions/defaults', {
      areas: { rooms: 'ask' },
      surface: 'cli',
    });
    expect(out()).toContain('rooms is now Ask for every agent.');
    // The same count every app surface shows: the auditor has Rooms of its own.
    expect(out()).toContain('Affects 1 agent.');
    expect(out()).toContain('1 agent keeps its own settings');
  });

  it('sets a single action, and resets one with null', async () => {
    apiCallMock.mockImplementation(async (method: string) =>
      method === 'GET' ? OVERVIEW : { changes: [], permissions: { ...OVERVIEW, exceptions: [] } }
    );
    expect(await runPermissionsDispatcher(['set', 'tasks_delete', 'blocked'])).toBe(0);
    expect(apiCallMock).toHaveBeenLastCalledWith('PATCH', '/api/permissions/defaults', {
      actions: { tasks_delete: 'blocked' },
      surface: 'cli',
    });
    await runPermissionsDispatcher(['reset', 'rooms']);
    expect(apiCallMock).toHaveBeenLastCalledWith('PATCH', '/api/permissions/defaults', {
      areas: { rooms: null },
      surface: 'cli',
    });
  });

  it('catches an action id the server does not have, and lists the real ones', async () => {
    apiCallMock.mockResolvedValue(OVERVIEW);
    expect(await runPermissionsDispatcher(['set', 'tasks.delete', 'blocked'])).toBe(1);
    expect(apiCallMock).not.toHaveBeenCalledWith('PATCH', expect.anything(), expect.anything());
    expect(err()).toContain("'tasks.delete' is not an area or an action");
    expect(err()).toContain('tasks: tasks_delete');
  });

  it('refuses a state that does not exist, before calling the server', async () => {
    expect(await runPermissionsDispatcher(['set', 'rooms', 'maybe'])).toBe(1);
    expect(apiCallMock).not.toHaveBeenCalled();
    expect(err()).toContain("'maybe' is not a state");
  });

  it('chooses a preset', async () => {
    apiCallMock.mockResolvedValue({ changes: [], permissions: OVERVIEW });
    expect(await runPermissionsDispatcher(['set', '--preset', 'balanced'])).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('PUT', '/api/permissions/preset', {
      preset: 'balanced',
      surface: 'cli',
    });
    expect(out()).toContain('Preset is now Balanced.');
  });

  it('prints the server sentence and the acknowledge command when Full power needs it', async () => {
    apiCallMock.mockRejectedValue(ACK_REFUSAL);
    expect(await runPermissionsDispatcher(['set', '--preset', 'full'])).toBe(1);
    expect(err()).toContain('Confirm that in the app first');
    expect(err()).toContain('dorkos config acknowledge-autonomy');
  });

  it("prints the server's floor refusal as it is", async () => {
    apiCallMock.mockRejectedValue(
      new ApiError(400, {
        error: 'Reach & secrets is never Allowed.',
        code: 'FLOOR_NEVER_ALLOWED',
      })
    );
    expect(await runPermissionsDispatcher(['set', 'reach', 'allowed'])).toBe(1);
    expect(err()).toContain('Reach & secrets is never Allowed.');
    expect(err()).not.toContain('acknowledge-autonomy');
  });

  it('reads the history for one agent, found by name', async () => {
    apiCallMock.mockResolvedValueOnce(ROSTER).mockResolvedValueOnce({
      items: [
        {
          id: 'e1',
          occurredAt: '2026-09-24T10:00:00.000Z',
          actorLabel: 'Someone on this computer',
          actorDetail: null,
          summary: 'Rooms: Ask',
          metadata: {},
        },
      ],
      nextCursor: null,
    });
    expect(await runPermissionsDispatcher(['history', '--agent', 'dorkbot', '--limit', '5'])).toBe(
      0
    );
    expect(apiCallMock).toHaveBeenLastCalledWith(
      'GET',
      '/api/permissions/history?limit=5&agentId=a2'
    );
    expect(out()).toContain('Rooms: Ask');
    // The id is what `undo` takes.
    expect(out()).toMatch(/^e1\s/m);
  });

  it('undoes one change, and says what it left alone', async () => {
    apiCallMock.mockResolvedValue({
      changes: [
        {
          target: { kind: 'default' },
          key: { kind: 'area', area: 'rooms' },
          before: 'ask',
          after: null,
        },
      ],
      skipped: [
        {
          change: {
            target: { kind: 'agent', agentId: 'a1', agentPath: '/a1', agentName: 'Auditor' },
            key: { kind: 'area', area: 'rooms' },
            before: 'blocked',
            after: null,
          },
          current: 'ask',
          reason: 'changed-since',
        },
      ],
    });
    expect(await runPermissionsDispatcher(['undo', 'e1'])).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('POST', '/api/permissions/history/e1/undo', {});
    expect(out()).toContain('Undid 1 change.');
    expect(out()).toMatch(/Auditor\s+rooms\s+Blocked\s+changed since: now Ask/);
  });

  it('names a Files & commands stop as the stop, not the state that shares its value', async () => {
    apiCallMock.mockResolvedValue({
      changes: [],
      skipped: [
        {
          change: {
            target: { kind: 'default' },
            key: { kind: 'files' },
            before: 'ask',
            after: 'autonomy',
          },
          current: 'act',
          reason: 'changed-since',
        },
      ],
    });
    expect(await runPermissionsDispatcher(['undo', 'e2'])).toBe(0);
    expect(out()).toMatch(/Everyone\s+files\s+Ask first\s+changed since: now Act/);
  });

  it('on a conflict, names it and the --force next step', async () => {
    apiCallMock.mockRejectedValue(
      new ApiError(409, {
        error: 'This has changed since. Set it back anyway?',
        code: 'UNDO_CONFLICT',
        conflicts: [
          {
            change: {
              target: { kind: 'default' },
              key: { kind: 'area', area: 'rooms' },
              before: null,
              after: 'ask',
            },
            current: 'blocked',
            reason: 'changed-since',
          },
        ],
      } as { error: string; code: string })
    );
    expect(await runPermissionsDispatcher(['undo', 'e1'])).toBe(1);
    expect(err()).toContain('This has changed since.');
    expect(err()).toMatch(/Everyone\s+rooms\s+not set\s+changed since: now Blocked/);
    expect(err()).toContain('dorkos permissions undo e1 --force');

    apiCallMock.mockResolvedValue({ changes: [], skipped: [] });
    expect(await runPermissionsDispatcher(['undo', 'e1', '--force'])).toBe(0);
    expect(apiCallMock).toHaveBeenLastCalledWith('POST', '/api/permissions/history/e1/undo', {
      force: true,
    });
  });
});

describe('dorkos agent permissions', () => {
  const AGENT_VIEW = {
    agentId: 'a1',
    agentName: 'Auditor',
    overrides: { areas: { rooms: 'blocked' } },
    areas: [
      {
        ...OVERVIEW.areas[0],
        resolved: { state: 'blocked', source: 'agent-area', layer: 'agent' },
        inherited: { state: 'ask', source: 'default-area', layer: 'default' },
        changedOutsideAt: null,
      },
    ],
    filesAndCommands: {
      stop: 'ask',
      source: 'agent',
      inherited: { stop: 'autonomy', source: 'default' },
    },
  };

  it('shows one agent, found by display name', async () => {
    apiCallMock.mockResolvedValueOnce(ROSTER).mockResolvedValueOnce(AGENT_VIEW);
    expect(await runAgentPermissions(['auditor'])).toBe(0);
    expect(apiCallMock).toHaveBeenLastCalledWith('GET', '/api/agents/a1/permissions');
    expect(out()).toContain("Files & commands: Ask first (This agent's own setting)");
    expect(out()).toMatch(/Rooms\s+rooms\s+Blocked\s+This agent's own setting \(everyone: Ask\)/);
  });

  it("sets and resets an agent's own area", async () => {
    apiCallMock.mockResolvedValue(ROSTER);
    apiCallMock.mockImplementation(async (method: string) =>
      method === 'GET' ? ROSTER : { changes: [], permissions: AGENT_VIEW }
    );
    await runAgentPermissions(['security-auditor', 'set', 'rooms', 'blocked']);
    expect(apiCallMock).toHaveBeenLastCalledWith('PATCH', '/api/agents/a1/permissions', {
      areas: { rooms: 'blocked' },
      surface: 'cli',
    });
    await runAgentPermissions(['a1', 'reset', 'rooms']);
    expect(apiCallMock).toHaveBeenLastCalledWith('PATCH', '/api/agents/a1/permissions', {
      areas: { rooms: null },
      surface: 'cli',
    });
  });

  it("sets and resets an agent's own Files & commands stop", async () => {
    apiCallMock.mockImplementation(async (method: string) =>
      method === 'GET' ? ROSTER : { changes: [], permissions: AGENT_VIEW }
    );
    await runAgentPermissions(['dorkbot', 'set', 'files', 'ask']);
    expect(apiCallMock).toHaveBeenLastCalledWith('PATCH', '/api/agents/a2/permissions', {
      filesAndCommands: 'ask',
      surface: 'cli',
    });
    expect(out()).toContain("dorkbot's Files & commands is now Ask first.");
    await runAgentPermissions(['dorkbot', 'reset', 'files']);
    expect(apiCallMock).toHaveBeenLastCalledWith('PATCH', '/api/agents/a2/permissions', {
      filesAndCommands: null,
      surface: 'cli',
    });
  });

  it('prints the acknowledge command when Full autonomy needs it', async () => {
    apiCallMock.mockImplementation(async (method: string) => {
      if (method === 'GET') return ROSTER;
      throw ACK_REFUSAL;
    });
    expect(await runAgentPermissions(['dorkbot', 'set', 'files', 'autonomy'])).toBe(1);
    expect(err()).toContain('dorkos config acknowledge-autonomy');
  });

  it('says so when no agent matches', async () => {
    apiCallMock.mockResolvedValue(ROSTER);
    expect(await runAgentPermissions(['nobody'])).toBe(1);
    expect(err()).toContain("No agent called 'nobody'");
  });
});
