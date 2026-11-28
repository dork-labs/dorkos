/**
 * The five `tasks_*` tools as capabilities (spec `computer-side-starts-alone`
 * §5.1, C9a): they left the hand gate and Claude Code's folder, and the
 * registry now gates them on both MCP servers.
 *
 * What a person or an agent sees does not change:
 *
 * - **Names, words and inputs.** Each keeps its MCP tool name, description and
 *   input; an unknown argument is still dropped (`unknownArguments: 'drop'`),
 *   and the search hint still comes from the description.
 * - **The gate.** Each is gated by its old tool name (`gateActionId`), so a
 *   stored setting, an approval, the card, `HUB_OWNED_ACTIONS` and the audit
 *   row's `mcp.<name>` all keep that id. Tiers, areas, card fields and subjects
 *   are the hand table's rows (`mcp-tool-tiers.ts`, where they were).
 * - **The escalators.** `tasks_create` and `tasks_update` decide a mode, an
 *   approval or a credits raise as its own action, as they did on the hand
 *   gate, now through their `escalate` fields.
 * - **The caller.** On the in-session server the handlers read the session the
 *   registry verified, as they read the live session before; on the external
 *   server they read the token's agent and its marks, as
 *   `core/external-mcp/task-tools.ts` handed them.
 * - **Who is offered them.** Claude Code's in-session server and the external
 *   `/mcp` server, as before; the loopback listener hides them from Codex,
 *   OpenCode and Doe ({@link TASKS_AGENT_TOOL_NAMES}) until C12d.
 *
 * @module services/tasks/agent-tools/task-agent-capabilities
 */
import { z } from 'zod';
import { TaskSchema } from '@dorkos/shared/schemas';
import {
  CapabilityToolError,
  defineCapability,
  unwrapMcpEnvelope,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../../core/capabilities/capability-definition.js';
import type { CapabilityHandlerContext } from '../../core/capabilities/registry.js';
import type { AgentIdentity } from '../../core/agent-identity/agent-identity-service.js';
import type { ToolCallEscalatorCall } from '../../core/capabilities/tool-call-escalation.js';
import type { TurnMarks } from '../../core/turn-power/turn-marks.js';
import {
  TASKS_OFF_ERROR,
  type AgentToolDeps,
  type TaskProvenanceResolver,
} from '../../core/agent-tool-kit/agent-tool-kit.js';
import {
  agentModeEscalators,
  type AgentModeEscalators,
} from '../agent-mode/agent-mode-escalation.js';
import { getTasksTools } from './task-tool-definitions.js';
import {
  CREATE_TASK_INPUT,
  DELETE_TASK_INPUT,
  LIST_TASKS_INPUT,
  RUN_HISTORY_INPUT,
  UPDATE_TASK_INPUT,
} from './task-tool-inputs.js';
import {
  TASKS_CREATE_DESCRIPTION,
  TASKS_DELETE_DESCRIPTION,
  TASKS_LIST_DESCRIPTION,
  TASKS_RUN_HISTORY_DESCRIPTION,
  TASKS_UPDATE_DESCRIPTION,
} from './task-tool-copy.js';
import type { CallerAgentResolver, CallerMarksResolver } from './task-tool-parts.js';
import { reachOf } from './task-tool-reach.js';

/** The five tools' MCP names, which the loopback listener hides until C12d. */
export const TASKS_AGENT_TOOL_NAMES = [
  'tasks_list',
  'tasks_create',
  'tasks_update',
  'tasks_delete',
  'tasks_get_run_history',
] as const;

/** The tasks tool deps, or `undefined` when the registry was composed without them. */
function toolDepsOf(deps: CapabilityDeps): AgentToolDeps | undefined {
  return deps.operatorDeps;
}

/**
 * The marks of an external caller's turn (DOR-3036): that server names no session, so an agent is
 * read through its agent (any marked turn of it running now), and a caller DorkOS cannot identify
 * carries the outsider mark, since nothing vouches for it. Its schedule parks either way.
 *
 * @param tools - The tool deps, for the marks reader.
 * @param identity - The calling agent, when the request carried a resolved identity token.
 */
export function externalCallerMarks(
  tools: Pick<AgentToolDeps, 'tasksReach'>,
  identity: AgentIdentity | undefined
): TurnMarks {
  return identity && !identity.inactive
    ? reachOf(tools).marksOf(undefined, identity.agentPath)
    : { outsider: true };
}

/**
 * The agent an external caller's token names, for whose schedules it may make
 * and change (DOR-3640 R1). A revoked or expired token names nobody (DOR-3666):
 * dropping a credential never reaches further than having none.
 *
 * @param identity - The calling agent, when the request carried a resolved token.
 */
export function externalCallerAgent(
  identity: Pick<AgentIdentity, 'agentPath' | 'inactive'> | undefined
): CallerAgentResolver {
  return () => (identity && !identity.inactive ? identity.agentPath : undefined);
}

/** Who a call came from, as the handlers read it. */
type CallerResolvers = [TaskProvenanceResolver?, CallerMarksResolver?, CallerAgentResolver?];

/**
 * The caller the handlers read, from what the registry verified. On the
 * in-session server it is the chat (its id, its first id, its folder and its
 * agent); without a chat, nobody, as the introspection path always was. On any
 * other surface it is the token's agent and its marks, as on the external
 * server: never more than the token proves.
 *
 * @param tools - The tool deps.
 * @param context - What the registry verified about this call.
 */
function callerOf(tools: AgentToolDeps, context: CapabilityHandlerContext): CallerResolvers {
  if (context.mcpServer === 'in-session') {
    const { sessionId, identity, cwd, turnSessionIds, narrowedReads } = context;
    if (!sessionId) return [];
    return [
      () => ({
        sessionId,
        ...(identity ? { agentPath: identity.agentPath } : {}),
        ...(cwd ? { cwd } : {}),
        turnSessionIds: [...(turnSessionIds ?? [sessionId])],
        ...(narrowedReads ? { narrowedReads: true } : {}),
      }),
    ];
  }
  const { identity } = context;
  return [undefined, () => externalCallerMarks(tools, identity), externalCallerAgent(identity)];
}

/**
 * Run one tool's handler for one call and hand back its plain payload, or throw
 * its refusal as a {@link CapabilityToolError} so the wire envelope is the same.
 *
 * @param deps - The registry's dependency bag.
 * @param name - The tool's MCP name.
 * @param input - The parsed input.
 * @param context - What the registry verified about this call.
 */
async function runTool(
  deps: CapabilityDeps,
  name: (typeof TASKS_AGENT_TOOL_NAMES)[number],
  input: unknown,
  context: CapabilityHandlerContext
): Promise<unknown> {
  const tools = toolDepsOf(deps);
  if (!tools) throw new CapabilityToolError({ error: TASKS_OFF_ERROR });
  const tool = getTasksTools(tools, ...callerOf(tools, context)).find((t) => t.name === name);
  if (!tool) throw new Error(`No tasks tool named ${name}.`);
  return unwrapMcpEnvelope(await tool.handler(input as never));
}

const escalatorsByStore = new WeakMap<object, AgentModeEscalators>();

/**
 * The two escalators over this registry's task store, or `undefined` with Tasks
 * off: then no call is decided as another action, and the handler refuses it.
 *
 * @param deps - The registry's dependency bag.
 */
function escalatorsOf(deps: CapabilityDeps): AgentModeEscalators | undefined {
  const tools = toolDepsOf(deps);
  const store = tools?.taskStore;
  if (!store) return undefined;
  let escalators = escalatorsByStore.get(store);
  if (!escalators) {
    escalators = agentModeEscalators({
      store,
      ...(tools.meshCore && { meshCore: tools.meshCore }),
    });
    escalatorsByStore.set(store, escalators);
  }
  return escalators;
}

/**
 * Ask one of the two escalators, when Tasks runs.
 *
 * @param deps - The registry's dependency bag.
 * @param door - Which escalator.
 * @param call - The call, as the registry asks it.
 */
async function escalate(
  deps: CapabilityDeps,
  door: keyof AgentModeEscalators,
  call: ToolCallEscalatorCall
) {
  return (await escalatorsOf(deps)?.[door](call)) ?? null;
}

/** Both servers, as the hand tools were on both. */
const BOTH = ['in-session', 'external'] as const;

/** The MCP surface every moved tool shares: its old name, both servers, its old input rules. */
function surfaceOf(toolName: (typeof TASKS_AGENT_TOOL_NAMES)[number]) {
  return {
    toolName,
    servers: [...BOTH],
    unknownArguments: 'drop' as const,
    searchHintFrom: 'description' as const,
  };
}

/** `tasks_list`'s result, which the external server lists as its `outputSchema`. */
const TASKS_LIST_OUTPUT = z.object({ schedules: z.array(TaskSchema), count: z.number() });

/** The tasks tools agents call, on the in-session and external MCP servers. */
export const tasksAgentToolsDomain: CapabilityDomain = {
  name: 'tasks',
  capabilities: [
    defineCapability({
      id: 'tasks.list_tasks',
      gateActionId: 'tasks_list',
      title: 'List scheduled tasks',
      description: TASKS_LIST_DESCRIPTION,
      tier: 'observe',
      area: 'tasks',
      auditAction: 'mcp.tasks_list',
      input: z.object(LIST_TASKS_INPUT),
      output: TASKS_LIST_OUTPUT,
      surfaces: {
        mcp: {
          ...surfaceOf('tasks_list'),
          readOnlyCarveOut: true,
          structuredOutput: true,
          annotations: { idempotentHint: true },
        },
      },
      invoke: (deps, input, context) =>
        runTool(deps, 'tasks_list', input, context) as Promise<z.infer<typeof TASKS_LIST_OUTPUT>>,
    }),
    defineCapability({
      id: 'tasks.create_task',
      gateActionId: 'tasks_create',
      title: 'Create a scheduled task',
      description: TASKS_CREATE_DESCRIPTION,
      tier: 'act',
      area: 'tasks',
      approvalDisplayFields: ['name', 'cron', 'target'],
      auditAction: 'mcp.tasks_create',
      input: z.object(CREATE_TASK_INPUT),
      output: z.unknown(),
      surfaces: { mcp: surfaceOf('tasks_create') },
      escalate: (deps, call) => escalate(deps, 'create', call),
      invoke: (deps, input, context) => runTool(deps, 'tasks_create', input, context),
    }),
    defineCapability({
      id: 'tasks.update_task',
      gateActionId: 'tasks_update',
      title: 'Change a scheduled task',
      description: TASKS_UPDATE_DESCRIPTION,
      tier: 'act',
      area: 'tasks',
      approvalDisplayFields: ['id', 'name', 'cron', 'enabled'],
      approvalSubject: { field: 'id', kind: 'task' },
      auditAction: 'mcp.tasks_update',
      input: z.object(UPDATE_TASK_INPUT),
      output: z.unknown(),
      surfaces: { mcp: { ...surfaceOf('tasks_update'), annotations: { idempotentHint: true } } },
      escalate: (deps, call) => escalate(deps, 'update', call),
      invoke: (deps, input, context) => runTool(deps, 'tasks_update', input, context),
    }),
    defineCapability({
      id: 'tasks.delete_task',
      gateActionId: 'tasks_delete',
      title: 'Delete a scheduled task',
      description: TASKS_DELETE_DESCRIPTION,
      tier: 'destructive',
      area: 'tasks',
      approvalDisplayFields: ['id'],
      approvalSubject: { field: 'id', kind: 'task' },
      auditAction: 'mcp.tasks_delete',
      input: z.object(DELETE_TASK_INPUT),
      output: z.unknown(),
      surfaces: { mcp: { ...surfaceOf('tasks_delete'), annotations: { idempotentHint: true } } },
      invoke: (deps, input, context) => runTool(deps, 'tasks_delete', input, context),
    }),
    defineCapability({
      id: 'tasks.get_run_history',
      gateActionId: 'tasks_get_run_history',
      title: "Read a scheduled task's run history",
      description: TASKS_RUN_HISTORY_DESCRIPTION,
      tier: 'observe',
      area: 'tasks',
      auditAction: 'mcp.tasks_get_run_history',
      input: z.object(RUN_HISTORY_INPUT),
      output: z.unknown(),
      surfaces: {
        mcp: {
          ...surfaceOf('tasks_get_run_history'),
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true },
        },
      },
      invoke: (deps, input, context) => runTool(deps, 'tasks_get_run_history', input, context),
    }),
  ],
};
