/**
 * Zod schemas for what DorkOS sends to and reads from `codex app-server`.
 *
 * **Outbound params are strict.** The server silently DROPS an unknown param
 * (spike 1c), so a misspelt key is a no-op nobody would notice. The client
 * parses every request through these before it is written, and
 * `protocol-schemas.test.ts` checks every key and enum literal here against the
 * committed snapshot of the binary's own schema.
 *
 * **Inbound notifications are loose.** Only the fields DorkOS reads are
 * required; anything else passes through, because the protocol is additive. A
 * notification that fails its schema is logged once and dropped by the client,
 * never thrown into a turn.
 *
 * @module services/runtimes/codex/app-server/protocol/schemas
 */
import { z } from 'zod';
import type { ClientMethod, ServerNotificationMethod } from './methods.js';

/** `SandboxMode` values DorkOS sends on `thread/start` / `thread/resume`. */
export const SandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);

/** `AskForApproval` values DorkOS sends. */
export const AskForApprovalSchema = z.enum(['untrusted', 'on-request', 'never']);

/** The tagged `SandboxPolicy` `turn/start` takes. */
export const SandboxPolicySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('dangerFullAccess') }),
  z.strictObject({ type: z.literal('readOnly'), networkAccess: z.boolean() }),
  z.strictObject({
    type: z.literal('workspaceWrite'),
    writableRoots: z.array(z.string()),
    networkAccess: z.boolean(),
    excludeTmpdirEnvVar: z.boolean(),
    excludeSlashTmp: z.boolean(),
  }),
]);

const TextUserInputSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
  text_elements: z.array(z.unknown()),
});

const InitializeParamsSchema = z.strictObject({
  clientInfo: z.strictObject({
    name: z.string(),
    title: z.string().nullable(),
    version: z.string(),
  }),
  capabilities: z.strictObject({ experimentalApi: z.boolean() }).nullable(),
});

const threadLoadShape = {
  cwd: z.string(),
  model: z.string().optional(),
  approvalPolicy: AskForApprovalSchema,
  // `auto_review` / `guardian_subagent` let a model answer an approval; DorkOS
  // never sends them (spec §18).
  approvalsReviewer: z.literal('user'),
  sandbox: SandboxModeSchema,
  config: z.record(z.string(), z.unknown()),
};

const ThreadStartParamsSchema = z.strictObject(threadLoadShape);
const ThreadResumeParamsSchema = z.strictObject({ threadId: z.string(), ...threadLoadShape });

const TurnStartParamsSchema = z.strictObject({
  threadId: z.string(),
  input: z.array(TextUserInputSchema),
  clientUserMessageId: z.string().optional(),
  cwd: z.string(),
  approvalPolicy: AskForApprovalSchema,
  sandboxPolicy: SandboxPolicySchema,
  model: z.string().optional(),
  effort: z.string().optional(),
  summary: z.literal('auto'),
});

const TurnInterruptParamsSchema = z.strictObject({ threadId: z.string(), turnId: z.string() });

const ModelListParamsSchema = z.strictObject({
  cursor: z.string().nullable(),
  includeHidden: z.boolean(),
  limit: z.number().int(),
});

const ConfigReadParamsSchema = z.strictObject({ cwd: z.string() });

/**
 * The params schema for every request DorkOS sends. `null` means the method
 * takes no params (`account/rateLimits/read`).
 */
export const OUTBOUND_PARAMS: Record<ClientMethod, z.ZodType | null> = {
  initialize: InitializeParamsSchema,
  'model/list': ModelListParamsSchema,
  'config/read': ConfigReadParamsSchema,
  'account/rateLimits/read': null,
  'thread/start': ThreadStartParamsSchema,
  'thread/resume': ThreadResumeParamsSchema,
  'turn/start': TurnStartParamsSchema,
  'turn/interrupt': TurnInterruptParamsSchema,
  // Experimental (DorkOS opts in at initialize): whether a thread still has
  // background terminals running, so the reaper never kills one (spec §5).
  'thread/backgroundTerminals/list': z.strictObject({ threadId: z.string() }),
};

// --- Inbound -----------------------------------------------------------------

const TurnErrorSchema = z.looseObject({
  message: z.string(),
  codexErrorInfo: z.unknown().optional(),
  additionalDetails: z.string().nullable().optional(),
});

const TurnSchema = z.looseObject({
  id: z.string(),
  status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  error: TurnErrorSchema.nullable().optional(),
});

/** A `ThreadItem`: its type and id are required, the rest is per type. */
export const ThreadItemSchema = z.looseObject({ type: z.string(), id: z.string().optional() });

const TokenBreakdownSchema = z.looseObject({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});

const turnScoped = { threadId: z.string(), turnId: z.string() };
const itemDelta = z.looseObject({ ...turnScoped, itemId: z.string(), delta: z.string() });

/** Schemas for the notifications DorkOS reads. Others pass unvalidated (and unread). */
export const NOTIFICATION_SCHEMAS: Partial<Record<ServerNotificationMethod, z.ZodType>> = {
  'turn/started': z.looseObject({ threadId: z.string(), turn: TurnSchema }),
  'turn/completed': z.looseObject({ threadId: z.string(), turn: TurnSchema }),
  'item/started': z.looseObject({ ...turnScoped, item: ThreadItemSchema }),
  'item/completed': z.looseObject({ ...turnScoped, item: ThreadItemSchema }),
  'item/agentMessage/delta': itemDelta,
  'item/reasoning/summaryTextDelta': itemDelta,
  'item/commandExecution/outputDelta': itemDelta,
  'item/mcpToolCall/progress': z.looseObject({
    ...turnScoped,
    itemId: z.string(),
    message: z.string(),
  }),
  'turn/plan/updated': z.looseObject({
    ...turnScoped,
    explanation: z.string().nullable().optional(),
    plan: z.array(z.looseObject({ step: z.string(), status: z.string() })),
  }),
  'thread/tokenUsage/updated': z.looseObject({
    ...turnScoped,
    tokenUsage: z.looseObject({
      total: TokenBreakdownSchema,
      last: TokenBreakdownSchema,
      modelContextWindow: z.number().nullable(),
    }),
  }),
  'model/rerouted': z.looseObject({ ...turnScoped, fromModel: z.string(), toModel: z.string() }),
  error: z.looseObject({ ...turnScoped, error: TurnErrorSchema, willRetry: z.boolean() }),
  'serverRequest/resolved': z.looseObject({
    threadId: z.string(),
    requestId: z.union([z.string(), z.number()]),
  }),
  'thread/closed': z.looseObject({ threadId: z.string() }),
  'thread/compacted': z.looseObject(turnScoped),
  'account/rateLimits/updated': z.looseObject({ rateLimits: z.looseObject({}) }),
  configWarning: z.looseObject({ summary: z.string(), details: z.string().nullable().optional() }),
};
