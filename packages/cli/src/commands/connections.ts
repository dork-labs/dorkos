/**
 * Scoped connector access, execution, usage, and owner-review handoff for the CLI.
 *
 * Every program command names an agent and uses the running DorkOS server as the
 * authority boundary. Management requests stop at a browser handoff: the CLI may
 * describe a validated action, but only the signed-in DorkOS app can decide it.
 *
 * @module commands/connections
 */
import { parseArgs } from 'node:util';
import {
  ConnectorAccessibleConnectionsResponseSchema,
  ConnectorAccessibleOperationsResponseSchema,
  ConnectorExecutionResponseSchema,
  ConnectorProgramExecutionRequestSchema,
  ConnectorUsagePageSchema,
  type ConnectorExecutionResponse,
} from '@dorkos/shared/connector-schemas';
import { z } from 'zod';
import { apiCall } from '../lib/api-client.js';
import { printError, printJson, renderTable } from '../lib/operator-output.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';
import { readJsonSource, rejectExtraPositionals, requireNonblank } from './connections-args.js';
import {
  DEFAULT_CONNECTIONS_COMMAND_DEPS,
  connectorReviewErrorExitCode,
  runReviewRequestCommand,
  runReviewStatusCommand,
  type ConnectionsCommandDeps,
} from './connections-review.js';

/** Help text for `dorkos connections`. */
export const CONNECTIONS_HELP = `Usage: dorkos connections <subcommand> [options]

Use connector accounts already granted to one of your agents. Every program
command requires --agent; leaving it out never widens access.

Subcommands:
  list --agent <id> [--json]
      List connections the agent can use
  schema <connection-id> --agent <id> [--json]
      List the exact granted operations and their input schemas
  call <connection-id> <operation-revision-id> --agent <id> [options]
      Run one exact granted operation; output is always JSON
  usage --agent <id> [--cursor <cursor>] [--limit <n>] [--json]
      Show attempts attributed to the agent
  request --action <json> --idempotency-key <key> [--print | --json]
      Ask the owner to review a connector management action
  status <review-request-id> [--json]
      Read the requester-safe state of a management review

Review status exits:
      0  Applied                 4  Target unavailable
      2  Awaiting owner review  5  Expired
      3  Denied                 6  Outcome unknown
      7  Authentication needed  1  Request or upstream failure

Call options:
      --input <json>        Inline JSON object of operation arguments
      --input-file <path>   Read arguments from a file ('-' reads stdin)
      --approval <token>    Retry token from status:approval_required

Request options:
      --action <json>       Strict versioned management action
      --action-file <path>  Read the action from a file ('-' reads stdin)
      --idempotency-key <key>
                            Stable key for retrying the same request
      --print               Print the app link without opening a browser
      --json                Print the review state and app link as JSON

Examples:
  dorkos connections list --agent agent-01 --json
  dorkos connections schema connection-01 --agent agent-01
  dorkos connections call connection-01 revision-01 --agent agent-01 --input '{"query":"hello"}'
  dorkos connections usage --agent agent-01 --limit 20
  dorkos connections request --action '{"version":1,"kind":"pause","connectionId":"connection-01"}' --idempotency-key pause-connection-01
  dorkos connections status review-01 --json`;

interface AgentArgs {
  agentId: string;
  json: boolean;
}

interface SchemaArgs extends AgentArgs {
  connectionId: string;
}

interface CallArgs {
  agentId: string;
  connectionId: string;
  operationRevisionId: string;
  arguments: Record<string, unknown>;
  approvalToken?: string;
}

interface UsageArgs extends AgentArgs {
  cursor?: string;
  limit?: number;
}

function parseAgentArgs(rawArgs: string[]): AgentArgs {
  const usage = 'Usage: dorkos connections list --agent <id> [--json]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        agent: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    rethrowUnknownOption(error, 'connections list', usage);
  }
  return {
    agentId: requireNonblank(parsed.values.agent, '--agent', usage),
    json: Boolean(parsed.values.json),
  };
}

function parseSchemaArgs(rawArgs: string[]): SchemaArgs {
  const usage = 'Usage: dorkos connections schema <connection-id> --agent <id> [--json]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        agent: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    rethrowUnknownOption(error, 'connections schema', usage);
  }
  rejectExtraPositionals(parsed.positionals, 1, usage);
  return {
    connectionId: requireNonblank(parsed.positionals[0], '<connection-id>', usage),
    agentId: requireNonblank(parsed.values.agent, '--agent', usage),
    json: Boolean(parsed.values.json),
  };
}

function parseCallArgs(rawArgs: string[]): CallArgs {
  const usage =
    'Usage: dorkos connections call <connection-id> <operation-revision-id> --agent <id> [--input <json> | --input-file <path>] [--approval <token>]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        agent: { type: 'string' },
        input: { type: 'string' },
        'input-file': { type: 'string' },
        approval: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    rethrowUnknownOption(error, 'connections call', usage);
  }
  rejectExtraPositionals(parsed.positionals, 2, usage);
  const input = ConnectorProgramExecutionRequestSchema.parse({
    agentId: requireNonblank(parsed.values.agent, '--agent', usage),
    connectionId: requireNonblank(parsed.positionals[0], '<connection-id>', usage),
    operationRevisionId: requireNonblank(parsed.positionals[1], '<operation-revision-id>', usage),
    arguments: readJsonSource(
      parsed.values.input,
      parsed.values['input-file'],
      '--input',
      '--input-file',
      usage
    ),
  });
  const approvalToken =
    typeof parsed.values.approval === 'string' && parsed.values.approval.trim()
      ? parsed.values.approval.trim()
      : undefined;
  return {
    agentId: input.agentId,
    connectionId: input.connectionId,
    operationRevisionId: input.operationRevisionId,
    arguments: input.arguments,
    ...(approvalToken ? { approvalToken } : {}),
  };
}

function parseUsageArgs(rawArgs: string[]): UsageArgs {
  const usage =
    'Usage: dorkos connections usage --agent <id> [--cursor <cursor>] [--limit <n>] [--json]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        agent: { type: 'string' },
        cursor: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    rethrowUnknownOption(error, 'connections usage', usage);
  }
  const agentId = requireNonblank(parsed.values.agent, '--agent', usage);
  const cursor =
    typeof parsed.values.cursor === 'string' && parsed.values.cursor.trim()
      ? parsed.values.cursor.trim()
      : undefined;
  let limit: number | undefined;
  if (typeof parsed.values.limit === 'string') {
    limit = Number(parsed.values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error(
        `Invalid --limit '${parsed.values.limit}'; use an integer from 1 to 100.\n${usage}`
      );
    }
  }
  return {
    agentId,
    json: Boolean(parsed.values.json),
    ...(cursor ? { cursor } : {}),
    ...(limit ? { limit } : {}),
  };
}

async function runList(args: AgentArgs): Promise<number> {
  const query = new URLSearchParams({ agentId: args.agentId });
  const result = ConnectorAccessibleConnectionsResponseSchema.parse(
    await apiCall('GET', `/api/connectors/accessible?${query}`)
  );
  if (args.json) printJson(result);
  else if (result.connections.length === 0) console.log('No connector access for this agent.');
  else {
    console.log(
      renderTable(
        ['CONNECTION', 'SERVICE', 'LABEL', 'STATUS', 'CUSTODY', 'RECONCILIATION'],
        result.connections.map((connection) => [
          connection.connectionId,
          connection.toolkit,
          connection.label,
          connection.status,
          connection.custody,
          connection.reconciliationStatus,
        ])
      )
    );
  }
  return 0;
}

async function runSchema(args: SchemaArgs): Promise<number> {
  const query = new URLSearchParams({ agentId: args.agentId });
  const result = ConnectorAccessibleOperationsResponseSchema.parse(
    await apiCall(
      'GET',
      `/api/connectors/accessible/${encodeURIComponent(args.connectionId)}/operations?${query}`
    )
  );
  if (args.json) printJson(result);
  else if (result.operations.length === 0)
    console.log('No granted operations for this connection.');
  else {
    console.log(
      renderTable(
        ['REVISION', 'OPERATION', 'VERSION', 'ACCESS', 'RETRY'],
        result.operations.map((operation) => [
          operation.operationRevisionId,
          operation.operationSlug,
          operation.toolkitVersion,
          operation.capabilityClassification,
          operation.retryPolicy,
        ])
      )
    );
    console.log('\nUse --json to inspect each operation input schema.');
  }
  return 0;
}

const NonblankStringSchema = z.string().refine((value) => value.trim().length > 0);

const ApprovalRequiredSchema = z
  .object({
    status: z.literal('approval_required'),
    capabilityId: z.literal('connectors.execute_destructive'),
    capabilityTitle: NonblankStringSchema,
    tier: z.literal('destructive'),
    approvalId: NonblankStringSchema,
    approvalToken: NonblankStringSchema,
    expiresAt: z.string().datetime(),
    reason: z.enum([
      'no_approval',
      'expired',
      'already_used',
      'wrong_action',
      'unknown_token',
      'awaiting_decision',
    ]),
    message: NonblankStringSchema,
    retry: z
      .object({
        channel: z.literal('http-header'),
        field: z.literal('X-DorkOS-Approval'),
        instructions: NonblankStringSchema,
      })
      .strict(),
  })
  .strict();

type ApprovalRequired = z.infer<typeof ApprovalRequiredSchema>;

function parseCallResponse(value: unknown): ConnectorExecutionResponse | ApprovalRequired {
  if (typeof value === 'object' && value !== null && 'status' in value) {
    return ApprovalRequiredSchema.parse(value);
  }
  return ConnectorExecutionResponseSchema.parse(value);
}

function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function connectorApprovalRetryInstructions(args: CallArgs, approvalToken: string): string {
  const command = [
    'dorkos connections call',
    quoteShellArgument(args.connectionId),
    quoteShellArgument(args.operationRevisionId),
    '--agent',
    quoteShellArgument(args.agentId),
    '--approval',
    quoteShellArgument(approvalToken),
    '--input',
    quoteShellArgument(JSON.stringify(args.arguments)),
  ].join(' ');
  return `Once approved, retry exactly: ${command}. Changing any value invalidates the approval.`;
}

async function runCall(args: CallArgs): Promise<number> {
  const result = parseCallResponse(
    await apiCall(
      'POST',
      '/api/connectors/cli/executions',
      {
        agentId: args.agentId,
        connectionId: args.connectionId,
        operationRevisionId: args.operationRevisionId,
        arguments: args.arguments,
      },
      args.approvalToken ? { 'X-DorkOS-Approval': args.approvalToken } : undefined
    )
  );
  if ('status' in result) {
    printJson({
      ...result,
      retry: {
        ...result.retry,
        instructions: connectorApprovalRetryInstructions(args, result.approvalToken),
      },
    });
    return 1;
  }
  printJson(result);
  return result.result.status === 'success' ? 0 : 1;
}

async function runUsage(args: UsageArgs): Promise<number> {
  const query = new URLSearchParams({ agentId: args.agentId });
  if (args.cursor) query.set('cursor', args.cursor);
  if (args.limit !== undefined) query.set('limit', String(args.limit));
  const result = ConnectorUsagePageSchema.parse(
    await apiCall('GET', `/api/connectors/usage/agent?${query}`)
  );
  if (args.json) printJson(result);
  else if (result.items.length === 0) console.log('No connector usage for this agent.');
  else {
    console.log(
      renderTable(
        ['STARTED', 'SERVICE', 'OPERATION', 'CONNECTION', 'ATTEMPT', 'OUTCOME'],
        result.items.map((item) => [
          item.startedAt,
          item.toolkit,
          item.operationSlug,
          item.connectionId,
          String(item.attemptIndex),
          item.outcome ?? 'in progress',
        ])
      )
    );
    if (result.nextCursor) console.log(`\nNext cursor: ${result.nextCursor}`);
  }
  return 0;
}

/**
 * Dispatch `dorkos connections <subcommand>`.
 *
 * @param rawArgs - Argv after `connections`.
 * @param deps - Injectable browser and terminal behavior.
 * @returns The intended process exit code.
 */
export async function runConnectionsDispatcher(
  rawArgs: string[],
  deps: ConnectionsCommandDeps = DEFAULT_CONNECTIONS_COMMAND_DEPS
): Promise<number> {
  const subcommand = rawArgs[0];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(CONNECTIONS_HELP);
    return subcommand === undefined ? 1 : 0;
  }
  const args = rawArgs.slice(1);
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(CONNECTIONS_HELP);
    return 0;
  }
  try {
    if (subcommand === 'list') return await runList(parseAgentArgs(args));
    if (subcommand === 'schema') return await runSchema(parseSchemaArgs(args));
    if (subcommand === 'call') return await runCall(parseCallArgs(args));
    if (subcommand === 'usage') return await runUsage(parseUsageArgs(args));
    if (subcommand === 'request') return await runReviewRequestCommand(args, deps);
    if (subcommand === 'status') return await runReviewStatusCommand(args);
  } catch (error) {
    printError(error);
    return connectorReviewErrorExitCode(error) ?? 1;
  }
  console.error(`Unknown connections subcommand: ${subcommand}`);
  console.error(CONNECTIONS_HELP);
  return 1;
}
