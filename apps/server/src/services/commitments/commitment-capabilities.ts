/**
 * The `commitments` capability domain (spec `heartbeats` §12): `commitment_add`,
 * `commitment_update` and `commitments_list`.
 *
 * ## The caller is the verified identity
 *
 * `commitment_add` takes no "who": the promise is the calling agent's own, read
 * off `context.identity`, and its chat is `context.sessionId`. A call with no
 * agent behind it is refused (`NO_AGENT`); a person adds one for an agent in the
 * app. `commitment_update` lets the promising agent or a person change one, and
 * refuses any other agent (`NOT_YOURS`). `commitments_list` reads every agent's
 * list, because promises are readable by everyone in the space (canon §5.5).
 *
 * ## Permission
 *
 * All three are `area: null`, as `memory_write` is. They touch nothing but the
 * agent's own record of what it said it would do, and that record is how people
 * see its promises: a switch that blocked it would hide promises from people
 * without stopping any of them being made.
 *
 * ## Who sees what
 *
 * `commitments_list` never returns `sourceSessionId`: which chat a promise was
 * made in is the owner's to see, in the app, and chats are owner-only
 * everywhere else too. It defaults to open promises, 50 rows at most.
 *
 * ## Known limit: outsiders (closed by DOR-2788 PR 3)
 *
 * The capability context carries no turn origin, so `commitments_list` can run
 * on a room turn an outsider started (a Telegram or Slack message), and that
 * turn reads every agent's open promises. The promise texts are the agents'
 * own words, not secrets, but trust does not extend to strangers (PRINCIPLES
 * §1). DOR-2788 PR 3 threads the turn origin through and closes this; until
 * then it is a known gap, not a decision.
 *
 * @module services/commitments/commitment-capabilities
 */
import { z } from 'zod';
import {
  COMMITMENT_LIST_MAX,
  COMMITMENT_NOTE_MAX,
  COMMITMENT_TO_MAX,
  COMMITMENT_WHAT_MAX,
  CommitmentSchema,
  CommitmentStateSchema,
} from '@dorkos/shared/commitment-schemas';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../core/capabilities/index.js';
import {
  CommitmentError,
  type CommitmentActor,
  type CommitmentService,
} from './commitment-service.js';

/** The MCP tool names, exported so prose that names them reads them from here. */
export const COMMITMENT_ADD_TOOL = 'commitment_add';
/** See {@link COMMITMENT_ADD_TOOL}. */
export const COMMITMENT_UPDATE_TOOL = 'commitment_update';
/** See {@link COMMITMENT_ADD_TOOL}. */
export const COMMITMENTS_LIST_TOOL = 'commitments_list';

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Present when the commitments service is running; gates the `commitments` domain. */
    commitmentDeps?: {
      /** Records, reads and changes commitments. */
      service: Pick<CommitmentService, 'create' | 'update' | 'list'>;
      /**
       * The Mesh id of the agent living at a home folder, or undefined when Mesh
       * does not know it.
       *
       * @param agentPath - The agent's home folder.
       */
      agentIdForPath(agentPath: string): string | undefined;
    };
  }
}

/** A refusal, as every commitment tool answers one. */
const RefusalSchema = z.object({
  ok: z.literal(false),
  /** A stable code. */
  code: z.string(),
  /** A plain sentence for the calling agent. */
  error: z.string(),
});

/** A refusal value. */
type Refusal = z.infer<typeof RefusalSchema>;

/** Narrow the bag, throwing if the registry was composed without it. */
function requireCommitmentDeps(
  deps: CapabilityDeps
): NonNullable<CapabilityDeps['commitmentDeps']> {
  if (!deps.commitmentDeps) {
    throw new Error('Commitment capability invoked without commitmentDeps in the registry bag.');
  }
  return deps.commitmentDeps;
}

/** The refusal for a call with no agent behind it. */
const NO_AGENT: Refusal = {
  ok: false,
  code: 'NO_AGENT',
  error:
    'Only an agent can record its own promise. This chat is not running as one of your agents, ' +
    'so nothing was recorded.',
};

/**
 * The calling agent's Mesh id, or a refusal.
 *
 * @param deps - The commitment deps.
 * @param context - The invocation context.
 */
function callingAgentId(
  deps: NonNullable<CapabilityDeps['commitmentDeps']>,
  context: CapabilityHandlerContext
): string | Refusal {
  const identity = context.identity;
  if (!identity || identity.inactive) return NO_AGENT;
  const agentId = deps.agentIdForPath(identity.agentPath);
  if (!agentId) {
    return {
      ok: false,
      code: 'UNKNOWN_AGENT',
      error: 'This agent is not registered on the team yet, so its promises cannot be kept here.',
    };
  }
  return agentId;
}

/**
 * Who is changing a commitment: the calling agent, a person, or a refusal.
 *
 * A machine that claimed an identity which did not verify, or an in-session
 * chat with no agent, is never read as the person: that is the confusion that
 * once let a revoked agent act as the operator (DOR-1361).
 *
 * @param deps - The commitment deps.
 * @param context - The invocation context.
 */
function actorOf(
  deps: NonNullable<CapabilityDeps['commitmentDeps']>,
  context: CapabilityHandlerContext
): CommitmentActor | Refusal {
  if (context.identity) {
    const agentId = callingAgentId(deps, context);
    return typeof agentId === 'string' ? { kind: 'agent', agentId } : agentId;
  }
  if (context.agentIdentityPresented || context.mcpServer === 'in-session') return NO_AGENT;
  return { kind: 'person' };
}

/** Run a commitment tool, answering a {@link CommitmentError} as a refusal. */
function answer<T>(run: () => T): T | Refusal {
  try {
    return run();
  } catch (err) {
    if (err instanceof CommitmentError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }
}

/** How many rows `commitments_list` returns when the caller names no limit. */
const LIST_DEFAULT_LIMIT = 50;

/** An ISO 8601 date-time with an offset. */
const DueAtInput = z.string().datetime({ offset: true });

/** The commitments domain. */
export const commitmentsDomain: CapabilityDomain = {
  name: 'commitments',
  assertDeps: requireCommitmentDeps,
  capabilities: [
    defineCapability({
      id: 'commitments.add',
      title: 'Record a promise',
      description:
        'Record something you promised, once you have promised it, so it never lives only in a ' +
        'chat. Everyone on the team can read your list. `what` is the promise in one plain line ' +
        '("Send Acme the revised quote"). `to` is who it was made to: a person, an agent id, or ' +
        '`external:<name>` for someone outside the business. `dueAt` is when it is due (ISO ' +
        '8601 with an offset, never in the past); an hour after it comes due it is marked missed ' +
        'unless you kept it or moved the date. A promise to an outsider ' +
        '(a date, a price, a discount) commits other people: ask first, then record it. When you ' +
        'have done it, mark it kept with the promise-update tool.',
      tier: 'act',
      area: null,
      areaNote: "the agent's own record of its promises, which people read",
      input: z.object({
        what: z
          .string()
          .trim()
          .min(1)
          .max(COMMITMENT_WHAT_MAX)
          .describe('The promise, in one plain line.'),
        to: z
          .string()
          .trim()
          .min(1)
          .max(COMMITMENT_TO_MAX)
          .optional()
          .describe('Who it was made to: a person, an agent id, or `external:<name>`.'),
        dueAt: DueAtInput.optional().describe('When it is due, ISO 8601 with an offset.'),
        sourceEntryId: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('The room message id the promise was made in, when it was made in a room.'),
      }),
      output: z.union([
        z.object({ ok: z.literal(true), commitment: CommitmentSchema }),
        RefusalSchema,
      ]),
      surfaces: {
        mcp: {
          toolName: COMMITMENT_ADD_TOOL,
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: false },
        },
      },
      invoke: async (deps, input, context) => {
        const commitmentDeps = requireCommitmentDeps(deps);
        const agentId = callingAgentId(commitmentDeps, context);
        if (typeof agentId !== 'string') return agentId;
        const commitment = commitmentDeps.service.create(agentId, {
          what: input.what,
          ...(input.to ? { to: input.to } : {}),
          ...(input.dueAt ? { dueAt: input.dueAt } : {}),
          ...(context.sessionId ? { sourceSessionId: context.sessionId } : {}),
          ...(input.sourceEntryId ? { sourceRoomEntryId: input.sourceEntryId } : {}),
        });
        return { ok: true as const, commitment };
      },
    }),
    defineCapability({
      id: 'commitments.update',
      title: 'Update a promise',
      description:
        'Change one of your promises. `state: "kept"` when you have done it, `"dropped"` when it ' +
        'no longer applies (say why in `note`), `"missed"` when you could not make it. To move ' +
        'the date, pass `state: "open"` with a new `dueAt`, and tell the person you promised. ' +
        'The same reopens a closed promise. Only the agent that promised, or a person, can ' +
        'change a promise.',
      tier: 'act',
      area: null,
      areaNote: "the agent's own record of its promises, which people read",
      input: z.object({
        id: z.string().min(1).max(100).describe('The promise id, from commitments_list.'),
        state: CommitmentStateSchema.describe('kept, dropped, missed, or open to move the date.'),
        from: CommitmentStateSchema.optional().describe(
          'The state you believe it is in now. If it changed since, nothing changes.'
        ),
        dueAt: DueAtInput.nullable()
          .optional()
          .describe('A new due date, with state open; never in the past. null removes the date.'),
        note: z
          .string()
          .trim()
          .max(COMMITMENT_NOTE_MAX)
          .optional()
          .describe('A short note on how it ended or why it moved.'),
      }),
      output: z.union([
        z.object({ ok: z.literal(true), commitment: CommitmentSchema }),
        RefusalSchema,
      ]),
      surfaces: {
        mcp: {
          toolName: COMMITMENT_UPDATE_TOOL,
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input, context) => {
        const commitmentDeps = requireCommitmentDeps(deps);
        const actor = actorOf(commitmentDeps, context);
        if ('ok' in actor) return actor;
        return answer(() => ({
          ok: true as const,
          commitment: commitmentDeps.service.update(actor, input.id, {
            state: input.state,
            ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
            ...(input.from !== undefined ? { from: input.from } : {}),
          }),
        }));
      },
    }),
    defineCapability({
      id: 'commitments.list',
      title: 'Read promises',
      description:
        "Read what agents have promised: yours, or any agent's. Open promises only by default, " +
        'soonest due first; `overdue` marks one past its date. `state: "all"` adds closed ones, ' +
        'most recently closed first. Filter by `agentId` or `to`. At most `limit` rows (default ' +
        '50); `truncated: true` means more matched, so narrow the filter or raise `limit`.',
      tier: 'observe',
      area: null,
      areaNote: 'every promise is readable by everyone in the space',
      input: z.object({
        agentId: z.string().min(1).max(100).optional().describe("Only this agent's promises."),
        state: z
          .union([CommitmentStateSchema, z.literal('all')])
          .optional()
          .describe('Only promises in this state, or "all". Defaults to open.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(COMMITMENT_LIST_MAX)
          .optional()
          .describe('At most this many rows (default 50). Open promises come first.'),
        to: z
          .string()
          .min(1)
          .max(COMMITMENT_TO_MAX)
          .optional()
          .describe('Only promises made to this person, agent or `external:<name>`.'),
      }),
      output: z.object({
        commitments: z.array(CommitmentSchema),
        /** True when more matched than `limit`, so a cut list is never silent. */
        truncated: z.boolean(),
      }),
      surfaces: {
        mcp: {
          toolName: COMMITMENTS_LIST_TOOL,
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input) => {
        const { state = 'open', limit = LIST_DEFAULT_LIMIT, ...filter } = input;
        const list = requireCommitmentDeps(deps).service.list(
          { ...filter, ...(state === 'all' ? {} : { state }) },
          // One more than asked, so a list cut at `limit` says so.
          limit + 1
        );
        // Which chat a promise was made in is the owner's to see (module TSDoc).
        return {
          commitments: list.slice(0, limit).map((c) => ({ ...c, sourceSessionId: null })),
          truncated: list.length > limit,
        };
      },
    }),
  ],
};
