/**
 * Proof D4 for the five tasks tools (spec `computer-side-starts-alone` §8, C9a):
 * each, on the real in-session and external servers, keeps its name, words,
 * search hint, audit name, tier, area and tokenless access; its listed input
 * gains nothing but `approvalToken` where it can ask; an extra argument is
 * still dropped; and the loopback runtimes are not offered it.
 *
 * @module services/tasks/agent-tools/__tests__/tasks-tools-d4
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { searchHintFrom } from '../../../runtimes/shared/tools/tool-exposure-policy.js';
import { createDorkOsToolServer } from '../../../runtimes/claude-code/mcp-tools/index.js';
import { createExternalMcpServer } from '../../../core/mcp-server.js';
import { READ_ONLY_MCP_TOOL_NAMES } from '../../../core/external-mcp/tool-security.js';
import type { AgentToolDeps } from '../../../core/agent-tool-kit/agent-tool-kit.js';
import { createTaskToolReach } from '../../../../startup/task-tool-reach.js';
import { TASKS_AGENT_TOOL_NAMES, tasksAgentToolsDomain } from '../task-agent-capabilities.js';
import { getTasksTools } from '../task-tool-definitions.js';

/** The hand table's rows, as they stood before C9a (`mcp-tool-tiers.ts`). */
const HAND_ROWS = {
  tasks_list: { tier: 'observe', title: 'List scheduled tasks', annotations: [true, false, true] },
  tasks_create: {
    tier: 'act',
    title: 'Create a scheduled task',
    annotations: [false, false, false],
  },
  tasks_update: {
    tier: 'act',
    title: 'Change a scheduled task',
    annotations: [false, false, true],
  },
  tasks_delete: {
    tier: 'destructive',
    title: 'Delete a scheduled task',
    annotations: [false, true, true],
  },
  tasks_get_run_history: {
    tier: 'observe',
    title: "Read a scheduled task's run history",
    annotations: [true, false, true],
  },
} as const;

/** A registered tool, as the MCP SDK keeps it. */
interface Registered {
  description?: string;
  inputSchema?: { shape?: Record<string, unknown>; _zod?: { def?: { catchall?: unknown } } };
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  _meta?: Record<string, unknown>;
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
}

function deps(): AgentToolDeps {
  return {
    transcriptReader: { listSessions: async () => [] },
    defaultCwd: '/tmp/d4',
    dorkHome: '/tmp/d4-home',
    taskStore: { getTasks: () => [], runHistory: () => () => ({ lastRunAt: null }) },
    tasksReach: createTaskToolReach(),
  } as unknown as AgentToolDeps;
}

const registered = (server: unknown) =>
  (server as { _registeredTools: Record<string, Registered> })._registeredTools;

const inSession = registered(createDorkOsToolServer(deps()).instance);
const external = registered(createExternalMcpServer(deps()));
const hand = Object.fromEntries(getTasksTools(deps()).map((t) => [t.name, t]));

describe.each(TASKS_AGENT_TOOL_NAMES)('%s (D4)', (name) => {
  const capability = tasksAgentToolsDomain.capabilities.find((c) => c.gateActionId === name)!;
  const row = HAND_ROWS[name];

  it('keeps its name and words on both servers, and its search hint in session', () => {
    for (const server of [inSession, external]) {
      expect(server[name]?.description).toBe(hand[name]!.description);
    }
    expect(inSession[name]!._meta?.['anthropic/searchHint']).toBe(
      searchHintFrom(hand[name]!.description)
    );
  });

  it('keeps its audit name, tier, area and card title', () => {
    expect(capability.auditAction).toBe(`mcp.${name}`);
    expect(capability.tier).toBe(row.tier);
    expect(capability.area).toBe('tasks');
    expect(capability.title).toBe(row.title);
  });

  it('lists the same input, plus approvalToken only where it can ask, and drops an unknown one', () => {
    const asks = row.tier !== 'observe';
    for (const server of [inSession, external]) {
      const keys = Object.keys(server[name]!.inputSchema?.shape ?? {}).sort();
      const expected = [
        ...Object.keys(hand[name]!.inputSchema),
        ...(asks ? ['approvalToken'] : []),
      ];
      expect(keys).toEqual(expected.sort());
    }
  });

  it('keeps its external annotations and tokenless access', () => {
    const [readOnlyHint, destructiveHint, idempotentHint] = row.annotations;
    expect(external[name]!.annotations).toMatchObject({
      readOnlyHint,
      destructiveHint,
      idempotentHint,
    });
    expect(READ_ONLY_MCP_TOOL_NAMES.has(name)).toBe(row.tier === 'observe');
  });
});

describe('the tasks tools beside one another (D4)', () => {
  it('still answers a call with an extra unknown argument', async () => {
    for (const server of [inSession, external]) {
      const result = await server.tasks_list!.handler({ enabled_only: false, bogus: 1 }, {});
      expect(result.isError).toBeFalsy();
      expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ count: 0 });
    }
  });

  it('lists tasks_list’s output schema on the external server, as before', () => {
    expect(external.tasks_list!.outputSchema).toBeDefined();
  });

  it('is not offered to Codex, OpenCode or Doe: the loopback listener hides all five', () => {
    const source = fs.readFileSync(
      new URL('../../../../startup/steps/capabilities.ts', import.meta.url),
      'utf8'
    );
    const hidden = source.slice(source.indexOf('agentServerFactory'));
    expect(hidden).toContain('...TASKS_AGENT_TOOL_NAMES,');
    expect(hidden.indexOf('...TASKS_AGENT_TOOL_NAMES')).toBeLessThan(
      hidden.indexOf('createAgentRuntimeMcpServer(')
    );
  });
});
