/**
 * The `tasks_*` guard on the IN-SESSION `dorkos` MCP server (DOR-504).
 *
 * Driven through `getTasksTools`, the array `mcp-tools/index.ts` hands the
 * session, rather than through the handler factories directly — so this covers
 * the handler a real session actually calls. The external `/mcp` server's half of
 * the same guarantee is proved end-to-end over HTTP in
 * `core/external-mcp/__tests__/task-permission-mode.test.ts`.
 *
 * The assertion that matters most is not "it returned an error". It is that after
 * a refused call the task on disk is BYTE-FOR-BYTE what it was: an agent that
 * sends `{prompt, cron, permissionMode}` must not get the first two applied and
 * the third dropped, because then it believes all three landed.
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/task-tools
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
  type AgentIdentityService,
} from '../../../../core/agent-identity/index.js';
import { TaskStore } from '../../../../tasks/task-store.js';
import type { McpToolDeps } from '../types.js';
import { getTasksTools } from '../task-tools.js';
import { handRegisteredInSessionTools } from '../index.js';
import type { Task } from '@dorkos/shared/schemas';

/** The shape `tool()` returns, narrowed to what this test drives. */
interface SessionTool {
  name: string;
  description: string;
  /** Each entry is the argument's Zod schema; `isOptional()` is how "required" is asked. */
  inputSchema: Record<string, { description?: string; isOptional?: () => boolean }>;
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
}

describe('tasks_* operator-only field guard (in-session dorkos server)', () => {
  let db: Db;
  let store: TaskStore;
  let tools: Record<string, SessionTool>;
  let existing: Task;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    const deps = { taskStore: store, defaultCwd: '/tmp/test' } as unknown as McpToolDeps;
    tools = Object.fromEntries(
      (getTasksTools(deps) as unknown as SessionTool[]).map((t) => [t.name, t])
    );
    existing = store.createTask({
      name: 'nightly',
      description: 'nightly',
      prompt: 'the prompt the person approved',
      cron: '0 2 * * *',
      filePath: '/tmp/tasks/nightly/SKILL.md',
    });
  });

  afterEach(() => {
    store.close();
  });

  /** Call a tool and parse its single JSON content block. */
  async function call(name: string, args: Record<string, unknown>) {
    const result = await tools[name]!.handler(args, undefined);
    return {
      isError: result.isError === true,
      payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
    };
  }

  it('advertises permissionMode as a field it refuses, on both tools', () => {
    // Deleting the argument instead would be worse, not better: the MCP SDK
    // strips an undeclared argument before the handler runs, so the refusal
    // would become a silent drop. Declared-and-refused is what lets the handler
    // see it. If this ever fails because somebody removed the field, read the
    // REFUSED_PERMISSION_MODE_DESCRIPTION TSDoc before "fixing" the test.
    for (const name of ['tasks_create', 'tasks_update']) {
      const described = tools[name]!.inputSchema.permissionMode?.description ?? '';
      expect(described, `${name} must still advertise permissionMode`).toContain('Not yours');
    }
  });

  it('advertises status on both tools, so it is refused and not dropped', () => {
    // Review caught this missing: `status` was operator-only in the policy but
    // absent from the schemas, so the SDK stripped it and the call reported
    // SUCCESS with the other fields applied. Every operator-only field has to be
    // declared on every tool, or "we refuse the call whole" is only true of some
    // pairings — and the seeded skill pack tells agents it is true of all of them.
    for (const name of ['tasks_create', 'tasks_update']) {
      const described = tools[name]!.inputSchema.status?.description ?? '';
      expect(described, `${name} must advertise status`).toContain('Not yours');
    }
  });

  describe('tasks_update — the live escalation', () => {
    it('refuses permissionMode and writes NOTHING ELSE from the same call', async () => {
      const { isError, payload } = await call('tasks_update', {
        id: existing.id,
        prompt: 'a different prompt nobody approved',
        cron: '* * * * *',
        permissionMode: 'bypassPermissions',
      });

      expect(isError).toBe(true);
      expect(payload.code).toBe('operator_only_task_field');
      expect(payload.fields).toEqual(['permissionMode']);

      // The whole point: the two legitimate fields did not land either.
      const after = store.getTask(existing.id)!;
      expect(after.permissionMode).toBe('acceptEdits');
      expect(after.prompt).toBe('the prompt the person approved');
      expect(after.cron).toBe('0 2 * * *');
      expect(after.updatedAt).toBe(existing.updatedAt);
    });

    it('refuses every permission mode, not just bypassPermissions', async () => {
      for (const mode of ['bypassPermissions', 'dontAsk', 'auto', 'acceptEdits']) {
        const { isError } = await call('tasks_update', { id: existing.id, permissionMode: mode });
        expect(isError, `mode ${mode} must be refused`).toBe(true);
      }
      expect(store.getTask(existing.id)!.permissionMode).toBe('acceptEdits');
    });

    it('refuses status too, so a task cannot approve itself', async () => {
      const parked = store.updateTask(existing.id, { status: 'pending_approval' })!;
      // The reviewer's exact reproduction: a rename riding along with the status
      // flip. Before `status` was declared on the schema it was stripped, the
      // rename landed, and the call reported success.
      const { isError, payload } = await call('tasks_update', {
        id: parked.id,
        name: 'renamed-via-status-call',
        status: 'active',
      });
      expect(isError).toBe(true);
      expect(payload.fields).toEqual(['status']);

      const after = store.getTask(parked.id)!;
      expect(after.status).toBe('pending_approval');
      expect(after.name).toBe('nightly');
    });

    it('still applies the fields an agent may write', async () => {
      // The guard has to be provably narrow, or "everything is refused" would
      // pass every test above.
      const { isError, payload } = await call('tasks_update', {
        id: existing.id,
        prompt: 'an updated prompt',
        cron: '0 5 * * *',
        enabled: false,
        timezone: 'America/New_York',
      });
      expect(isError).toBe(false);
      expect(payload.schedule).toBeDefined();

      const after = store.getTask(existing.id)!;
      expect(after.prompt).toBe('an updated prompt');
      expect(after.cron).toBe('0 5 * * *');
      expect(after.enabled).toBe(false);
      expect(after.timezone).toBe('America/New_York');
      expect(after.permissionMode).toBe('acceptEdits');
    });
  });

  describe('tasks_create — the advertised-but-inert path', () => {
    it('refuses permissionMode and creates no task at all', async () => {
      const before = store.getTasks().length;
      const { isError, payload } = await call('tasks_create', {
        name: 'sneaky',
        prompt: 'do a thing',
        cron: '0 3 * * *',
        permissionMode: 'bypassPermissions',
      });

      expect(isError).toBe(true);
      expect(payload.fields).toEqual(['permissionMode']);
      // Refused whole: no half-made task parked somewhere for a person to find.
      expect(store.getTasks()).toHaveLength(before);
    });

    it('refuses status on create too, so the skill pack tells agents the truth', async () => {
      // `status` is not a meaningful create argument — the store hardcodes it and
      // the handler then parks it — so nothing could have escalated either way.
      // It is declared and refused anyway because the skill pack promises the
      // whole call is refused for either field on either tool, and a silently
      // stripped field makes that promise false.
      const before = store.getTasks().length;
      const { isError, payload } = await call('tasks_create', {
        name: 'self-approving',
        prompt: 'do a thing',
        cron: '0 3 * * *',
        status: 'active',
      });

      expect(isError).toBe(true);
      expect(payload.fields).toEqual(['status']);
      expect(store.getTasks()).toHaveLength(before);
    });

    it('still creates an ordinary task, parked at pending_approval', async () => {
      const { isError, payload } = await call('tasks_create', {
        name: 'ordinary',
        prompt: 'do a thing',
        cron: '0 3 * * *',
        reason: 'The overnight backlog needs sweeping before you start.',
      });
      expect(isError).toBe(false);
      const created = payload.schedule as Task;
      expect(created.status).toBe('pending_approval');
      expect(created.permissionMode).toBe('acceptEdits');
    });
  });
});

describe('tasks_create records who is proposing and why (DOR-1394)', () => {
  let db: Db;
  let store: TaskStore;
  let deps: McpToolDeps;
  let emit: ReturnType<typeof vi.fn>;
  let identity: AgentIdentityService;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    identity = initAgentIdentityService(db);
    emit = vi.fn();
    deps = {
      taskStore: store,
      defaultCwd: '/tmp/test',
      activityService: { emit },
    } as unknown as McpToolDeps;
  });

  afterEach(() => {
    resetAgentIdentityService();
    store.close();
  });

  /** The tool set a session gets, with `resolveProvenance` wired as `index.ts` wires it. */
  function toolsWith(resolveProvenance?: () => { sessionId?: string; agentPath?: string }) {
    return Object.fromEntries(
      (getTasksTools(deps, resolveProvenance) as unknown as SessionTool[]).map((t) => [t.name, t])
    );
  }

  /** Call `tasks_create` and parse its single JSON content block. */
  async function create(
    tools: Record<string, SessionTool>,
    args: Record<string, unknown>
  ): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
    const result = await tools.tasks_create!.handler(args, undefined);
    return {
      isError: result.isError === true,
      payload: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
    };
  }

  const GOOD_ARGS = {
    name: 'nightly-sweep',
    prompt: 'sweep the backlog',
    cron: '0 3 * * *',
    reason: 'The overnight backlog needs sweeping before you start.',
  };

  it('advertises reason as a required argument, in the words an agent has to answer', () => {
    const tools = toolsWith();
    expect(tools.tasks_create!.inputSchema.reason?.description).toContain('in your own words');
    // Required, not optional: the SDK parses a call against this schema before
    // the handler runs, so this is what makes a reasonless call impossible.
    expect(tools.tasks_create!.inputSchema.reason?.isOptional?.()).not.toBe(true);
  });

  it('stores the reason on the task', async () => {
    const { isError } = await create(toolsWith(), GOOD_ARGS);
    expect(isError).toBe(false);
    expect(store.getTasks()[0]!.reason).toBe(GOOD_ARGS.reason);
  });

  it('refuses a blank reason and creates nothing', async () => {
    for (const reason of ['', '   ', '\n\t']) {
      const { isError, payload } = await create(toolsWith(), { ...GOOD_ARGS, reason });
      expect(isError, `reason ${JSON.stringify(reason)} must be refused`).toBe(true);
      expect(String(payload.error)).toContain('needs a reason');
    }
    // Refused before the write, so nothing parked with nothing to read.
    expect(store.getTasks()).toHaveLength(0);
  });

  it('records the session and directory the proposal came from', async () => {
    const tools = toolsWith(() => ({ sessionId: 'ses-canonical', agentPath: '/tmp/agents/nb' }));
    await create(tools, GOOD_ARGS);

    const created = store.getTasks()[0]!;
    expect(created.proposedBySessionId).toBe('ses-canonical');
    expect(created.proposedByAgentPath).toBe('/tmp/agents/nb');
  });

  it('reads the session id at call time, not when the tools were built', async () => {
    // The SDK rekeys a session to its canonical id mid-first-turn, so a resolver
    // read once at construction would record the trigger id — a session nothing
    // can open. Reading late is the whole point of the resolver being a function.
    let current = 'ses-trigger';
    const tools = toolsWith(() => ({ sessionId: current, agentPath: '/tmp/agents/nb' }));

    current = 'ses-canonical';
    await create(tools, GOOD_ARGS);

    expect(store.getTasks()[0]!.proposedBySessionId).toBe('ses-canonical');
  });

  it('names the proposer in the activity feed, from the same answer the notification uses', async () => {
    await identity.mint({ agentPath: '/tmp/agents/nb', displayName: 'Nightly Bot' });
    const tools = toolsWith(() => ({ sessionId: 'ses-1', agentPath: '/tmp/agents/nb' }));

    await create(tools, GOOD_ARGS);

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'agent',
        actorLabel: 'Nightly Bot',
        actorId: '/tmp/agents/nb',
      })
    );
  });

  it('says "An agent" in the feed when nothing resolves a name', async () => {
    const tools = toolsWith(() => ({ sessionId: 'ses-1', agentPath: '/tmp/agents/unknown' }));

    await create(tools, GOOD_ARGS);

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ actorLabel: 'An agent' }));
  });

  it('picks the session up through the REAL composition root, not a hand-built resolver', async () => {
    // Every other case here injects `resolveProvenance` itself, so all of them
    // stay green if `mcp-tools/index.ts` stops PASSING one — which is the whole
    // wiring. This drives the same function a live session drives
    // (`createDorkOsToolServer` → `handRegisteredInSessionTools`) and hands it
    // only a session, so the argument in `getTasksTools(deps, …)` is load-bearing
    // for it (DOR-1394 review).
    const session = {
      eventQueue: [],
      cwd: '/tmp/agents/nb',
      sdkSessionId: 'ses-canonical',
    };

    const wired = Object.fromEntries(
      (handRegisteredInSessionTools(deps, { session }) as unknown as SessionTool[]).map((t) => [
        t.name,
        t,
      ])
    );
    await create(wired, GOOD_ARGS);

    const created = store.getTasks()[0]!;
    expect(created.proposedByAgentPath).toBe('/tmp/agents/nb');
    expect(created.proposedBySessionId).toBe('ses-canonical');
  });

  it('leaves provenance null on the sessionless external server, and still demands a reason', async () => {
    const tools = toolsWith();
    const { isError } = await create(tools, GOOD_ARGS);
    expect(isError).toBe(false);

    const created = store.getTasks()[0]!;
    expect(created.proposedBySessionId).toBeNull();
    expect(created.proposedByAgentPath).toBeNull();
    expect(created.reason).toBe(GOOD_ARGS.reason);

    const refused = await create(tools, { ...GOOD_ARGS, reason: ' ' });
    expect(refused.isError).toBe(true);
  });
});
