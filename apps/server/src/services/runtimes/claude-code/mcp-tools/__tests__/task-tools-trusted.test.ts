/**
 * `tasks_create` and `tasks_update` on a Trusted install (ADR 261006-225605,
 * spec `trusted-by-default-flip` §5.4).
 *
 * In a session the caller is one of our agents, so its schedule is armed at
 * once, recorded as `schedule.armed_by_agent`, and its own later edit keeps it
 * live. On the sessionless external `/mcp` server the caller cannot be told
 * from an outsider, so its schedule parks. The Careful half is
 * `task-tools.test.ts`, which runs on a Careful preset.
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/task-tools-trusted
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { TaskStore } from '../../../../tasks/task-store.js';
import type { McpToolDeps } from '../types.js';
import { getTasksTools } from '../task-tools.js';
import { ARMED_SCHEDULE_NOTE } from '../task-tool-copy.js';
import { handRegisteredInSessionTools } from '../index.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../../core/agent-identity/__tests__/agent-home-fixture.js';

vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'permissions' ? { preset: 'trusted' } : undefined),
  },
}));

beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

/** The shape `tool()` returns, narrowed to what this test drives. */
interface SessionTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

const GOOD_ARGS = {
  name: 'nightly-sweep',
  prompt: 'sweep the backlog',
  cron: '0 3 * * *',
  target: 'global',
  reason: 'The overnight backlog needs sweeping before you start.',
};

describe('tasks_* on a Trusted install', () => {
  let store: TaskStore;
  let deps: McpToolDeps;
  let emit: ReturnType<typeof vi.fn>;
  let dorkHome: string;

  beforeEach(async () => {
    store = new TaskStore(createTestDb());
    emit = vi.fn();
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-task-tools-trusted-'));
    deps = {
      taskStore: store,
      defaultCwd: '/tmp/test',
      dorkHome,
      activityService: { emit },
    } as unknown as McpToolDeps;
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  /** The tool set, with `resolveProvenance` as a session (present) or `/mcp` (absent) wires it. */
  function toolsWith(resolveProvenance?: () => { sessionId?: string; agentPath?: string }) {
    return Object.fromEntries(
      (getTasksTools(deps, resolveProvenance) as unknown as SessionTool[]).map((t) => [t.name, t])
    );
  }

  /** Call a tool and parse its single JSON content block. */
  async function call(tool: SessionTool, args: Record<string, unknown>) {
    const result = await tool.handler(args, undefined);
    return {
      isError: result.isError === true,
      payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
    };
  }

  const inSession = () => toolsWith(() => ({ sessionId: 'ses-1', agentPath: '/tmp/agents/nb' }));

  it('arms an agent’s schedule in a session, says so, and records it', async () => {
    const { isError, payload } = await call(inSession().tasks_create!, GOOD_ARGS);

    expect(isError).toBe(false);
    expect((payload.schedule as { status: string }).status).toBe('active');
    expect(payload.note).toBe(ARMED_SCHEDULE_NOTE);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'agent',
        actorId: '/tmp/agents/nb',
        eventType: 'schedule.armed_by_agent',
        metadata: { status: 'active' },
      })
    );
  });

  it('arms through the REAL composition root, which passes the session in', async () => {
    const session = { eventQueue: [], cwd: '/tmp/agents/nb', sdkSessionId: 'ses-canonical' };
    const wired = Object.fromEntries(
      (handRegisteredInSessionTools(deps, { session }) as unknown as SessionTool[]).map((t) => [
        t.name,
        t,
      ])
    );

    const { payload } = await call(wired.tasks_create!, GOOD_ARGS);

    expect((payload.schedule as { status: string }).status).toBe('active');
  });

  it('parks a schedule made over the external /mcp server', async () => {
    const { payload } = await call(toolsWith().tasks_create!, GOOD_ARGS);

    expect((payload.schedule as { status: string }).status).toBe('pending_approval');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'tasks.task_created' }));
  });

  it('keeps an agent’s own schedule live through its edit, with no re-approval', async () => {
    const tools = inSession();
    const created = await call(tools.tasks_create!, GOOD_ARGS);
    const id = (created.payload.schedule as { id: string }).id;

    const { isError, payload } = await call(tools.tasks_update!, {
      id,
      prompt: 'sweep the backlog and the inbox',
    });

    expect(isError).toBe(false);
    expect(payload.needsReapproval).toBeUndefined();
    expect(store.getTask(id)!.status).toBe('active');
  });

  it('re-asks when the same edit comes over the external /mcp server', async () => {
    const created = await call(inSession().tasks_create!, GOOD_ARGS);
    const id = (created.payload.schedule as { id: string }).id;

    const { payload } = await call(toolsWith().tasks_update!, {
      id,
      prompt: 'sweep the backlog and the inbox',
    });

    expect(payload.needsReapproval).toBe(true);
    expect(store.getTask(id)!.status).toBe('pending_approval');
  });
});
