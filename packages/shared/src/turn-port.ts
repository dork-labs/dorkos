/**
 * The turn port's contract: every value that crosses the one door a
 * space-side caller uses to start, watch and stop a turn (spec
 * `turns-survive-restarts` §3, ADR 261124-150517).
 *
 * The port has two faces. The **space face** (`services/runs`) takes a
 * {@link StartTurnInput}, saves a run and answers {@link StartTurnResult} at
 * acceptance. Only the space face calls the **computer face**
 * (`services/session/turn-port`), with a {@link TurnStartRequest}, and the
 * computer face answers {@link TurnStartAnswer}, then reports what happens to
 * the turn as {@link RunFact} values through one sink.
 *
 * Only `start` has payload schemas here. The argument schemas of `stop` and
 * `answer` arrive with their first callers; `stop` answers the existing
 * `InterruptReceipt` (`@dorkos/shared/schemas`).
 *
 * ## Plain data only
 *
 * Every payload here is a Zod schema over JSON values: strings, numbers,
 * booleans, arrays and plain objects. No function, class instance,
 * `AbortSignal` or live handle crosses the port, because the port is the
 * in-process form of a wire (`session-relay-agent-computer.ts`), and a value
 * that cannot be written to that wire would make the two forms disagree. Every
 * object is strict, so a callback slipped in beside the data is refused
 * rather than dropped. `__tests__/turn-port.test.ts` round-trips every schema
 * through JSON and walks each one to prove no member can hold anything else.
 *
 * ## The run record's vocabulary
 *
 * {@link RunStatus}, {@link RunEnding}, {@link AttemptReason},
 * {@link WaitReason} and the transition table ({@link RUN_TRANSITIONS},
 * {@link canTransition}) are the run record's words (spec §4.3, §4.4). They
 * live here, not in the run store, because the store's methods take and
 * return these types and never Drizzle rows (§4.2).
 *
 * A run is referenced as `dork:turn:<id>` ({@link runReference}); `dork:run:`
 * stays the reference of a scheduled task's run (spec §12, choice 3).
 *
 * @module shared/turn-port
 */
import { z } from 'zod';
import { AGENT_ID_PATTERN, formatDorkReference, parseDorkReference } from './dork-ref.js';
import { RelayAgentIdSchema, RelayMessageContentSchema } from './session-relay.js';
import {
  AgentComputerTurnOriginSchema,
  AgentComputerTurnTierSchema,
} from './session-relay-agent-computer.js';
import { SessionLaunchWarningSchema } from './session-launch-schemas.js';
import {
  BackgroundTaskTypeSchema,
  InterruptReceiptSchema,
  SEED_CONTEXT_MAX_LENGTH,
  SessionSettingsSchema,
} from './schemas.js';
import type { DirectoryGrant, TurnPermissionCeiling } from './agent-runtime.js';
import { RunEndingSchema, RunStatusSchema, type RunStatus } from './run-schemas.js';

// The record's words live in `run-schemas.ts`, which the session stream reads too.
export {
  RunEndingSchema,
  RunStatusSchema,
  WaitReasonSchema,
  type RunEnding,
  type RunStatus,
  type WaitReason,
} from './run-schemas.js';

// === Turn origin ===

/**
 * What is starting this turn, as the thing that knows describes itself.
 *
 * One member per turn-starting surface in the server. None of them names a
 * permission mode: mapping a surface onto a power level is
 * `permissionSeedForOrigin`'s job, which stays in the server beside the write
 * it decides (`apps/server/src/services/session/origin/turn-origin.ts`, which
 * also re-exports this type from its old path).
 *
 * A member is a bare discriminant unless a field changes an answer somebody
 * reads. Ids nothing reads are not carried "for later".
 */
export type TurnOrigin =
  /**
   * A person is here, watching. `POST /api/sessions/:id/messages` is the only
   * caller: a message posted there came from somebody holding that session's
   * event stream open, so a stop they configured is a stop they can answer.
   */
  | { readonly kind: 'interactive' }
  /**
   * The owner sent this from their own DorkOS on the web, through the session
   * relay (`services/core/session-relay/`): a viewer holds the chat's stream
   * open through the relay, the way `interactive`'s person holds it open here.
   * The relay is the owner, never an outsider, so the words are the owner's
   * own typing.
   */
  | { readonly kind: 'session-relay' }
  /**
   * A room turn — unattended, because a room triggers a turn into the dark.
   *
   * `externalAuthor` says whether the message that triggered it came from
   * somebody off this machine (a bridged Telegram or Slack chat). A bridged
   * chat is a projection of a relay binding into a room, and a binding carries
   * its own grant precisely because nobody picked a level for strangers
   * (DOR-604), so that is the one fact which changes a room's answer.
   */
  | { readonly kind: 'room'; readonly externalAuthor: boolean }
  /**
   * A scheduled task's run, whether the timer fired it or a person pressed
   * "Run now".
   *
   * Seeded with no mode: a run's power comes off
   * `pulse_schedules.permission_mode`, decided once at CREATE, and it reaches
   * the runtime through `ensureSession`/`sendMessage` rather than through this
   * row. Whether it should also reach the row is DOR-2100, which will add
   * whatever it needs to read here.
   */
  | { readonly kind: 'schedule' }
  /**
   * A chat binding created a session for an inbound message — Telegram, Slack,
   * a webhook. The binding carries the grant a person set on it, and an absent
   * grant there is NOT consent (DOR-604), so nothing about the operator's own
   * level may be seeded onto the row.
   */
  | { readonly kind: 'relay-binding' }
  /**
   * One agent addressed another directly over the relay (a publish to a mesh
   * endpoint stamped as one of our agents; agents' own send tool for this
   * retired with spec `spin-off-chats`, which routes them through chats). Nobody created a session for it and nobody is watching it;
   * like a binding, it carries its own grant and seeds no operator stop.
   */
  | { readonly kind: 'agent-dm' }
  /**
   * A message on the relay addressed to an agent, from a sender that is NOT one
   * of our agents: the A2A gateway (another company's agent), an external MCP
   * client, or a hand-built publish. It arrives on the same agent subject an
   * agent's own publish does, so the stamped sender is the only fact that
   * tells it apart, and it gets its own member so that a later change letting
   * our own agents' DMs follow a configured level can never carry it along
   * (spec `trusted-by-default-flip` §4).
   */
  | { readonly kind: 'outside-sender' }
  /**
   * A connector event woke an agent up (`services/connectors/events/`). Same
   * rule as a binding: the subscription a person approved is the grant, so the
   * row seeds no operator stop.
   */
  | { readonly kind: 'connector-event' }
  /**
   * An agent started this session through the `session_start` tool, or by
   * posting to `POST /api/sessions/:id/messages` with its identity. Nobody
   * chose a trust stop for it: the operator's stop is a promise about a person
   * who can answer, and the agent that asked for the session is not that
   * person. So the row seeds no operator stop. Its power is the mode the tool
   * grants: the calling chat's own live level or lower, checked against that
   * ceiling and always written to the row (spec `inherited-start-permission`).
   *
   * `launchedBy` names who chose where it runs (DOR-3644): the agent's Mesh id,
   * its home, or `unidentified`. The binding row keeps it.
   */
  | { readonly kind: 'agent-launch'; readonly launchedBy?: string }
  /**
   * An extension started work in a new chat (spec `flow-multiproject` §7.7):
   * a person's click on an outcome button (`api.startWork`), or the
   * extension's own rules deciding it (`ctx.sessions.start`). Either way the
   * chat is a new one in the person's own project, doing the person's work, so
   * it is born with the new-session defaults a person's chat gets: the seam
   * must not change the permission mode, in either direction.
   */
  | { readonly kind: 'extension-start' }
  /**
   * An extension's server half sent one of the person's agents a message
   * (`ctx.agent.send`, DOR-2683), opening the chat it keeps with that agent
   * on the first one. The words are app data, not a person's request, and
   * the extension is not the person the operator's stop was set for, so the
   * row seeds no operator stop — like a connector event waking an agent.
   * Sent into a chat that already exists, it changes nothing: that row was
   * bound first and keeps its power.
   */
  | { readonly kind: 'extension-message' }
  /**
   * Another chat sent this one a message (`chat_send`, a spin-off's report,
   * spec `spin-off-chats`), or opened an agent's DM chat to send the first.
   * A chat it OPENS is born at the operator's configured stop, the same as a
   * room turn by a local author, and every turn a message starts is held to
   * the sending chat's level by a ceiling the dispatcher reads at launch. So a
   * message runs at the stricter of the two, and never carries more power than
   * the chat that sent it. Seeding nothing here used to mean the runtime's
   * Default, which made that stricter of the two always Default: two Full
   * autonomy agents talking held each other to asking, and every reply after
   * the first kept it that way.
   */
  | { readonly kind: 'chat-message' }
  /**
   * A limited session's work carried over to a new session on another account
   * (spec `claude-account-fleet` D9), by a person or by the account advisor.
   * The new session's settings row is copied from the source session before
   * the send, and that copy is the power: this origin adds none.
   */
  | { readonly kind: 'account-handoff' }
  /**
   * A limited session's account reset and core resumed the SAME session by
   * itself (spec `claude-account-fleet` D9 "Wait, then resume by itself"). The
   * session is already bound, so its settings row decides its power: this
   * origin adds none.
   */
  | { readonly kind: 'account-resume' }
  /**
   * DorkOS starts a turn in a chat that is already bound, to hand it the
   * outcome of something it was waiting on (an approval's verdict, a finished
   * sign-in, a connector's answer, a hand-off that ended, work a restart cut
   * short). It never opens a chat. Nobody typed it, and the chat's own row is
   * its power, so it seeds nothing. A carry-on after an account's reset is
   * `account-resume`, not this.
   */
  | { readonly kind: 'resume' }
  /**
   * An agent's own heartbeat (spec `heartbeats` §7.2): a turn the beat runner
   * starts in the agent's beat chat for the day, when a beat found work.
   * Nobody started it by typing, and nobody is waiting on it, the same as a
   * room turn by a local author: trusted by default, at the operator's
   * configured stop. The origin seeds the chat's row once; whether a LATER turn
   * in that chat is a beat is the live registry's question
   * (`services/heartbeats/beat-turns.ts`), so a person typing in the beat chat
   * is an ordinary turn.
   */
  | { readonly kind: 'heartbeat' }
  /**
   * The in-process end-to-end harness, reachable only on a server started with
   * `DORKOS_TEST_RUNTIME`. It drives a runtime tool against a session it binds
   * itself.
   *
   * It is a named member rather than a borrowed one so no production surface's
   * power decision has to describe a test. Exactly one production file uses
   * it, and the server's `session/origin/__tests__/turn-origin-call-sites.test.ts`
   * is what keeps that true — a unit test that just needs a session bound
   * names the surface it is standing in for instead.
   */
  | { readonly kind: 'test-harness' };

/** A member of {@link TurnOrigin} that carries nothing but its kind. */
const bareOrigin = <K extends string>(kind: K) => z.strictObject({ kind: z.literal(kind) });

/**
 * {@link TurnOrigin} as a schema, so an origin can cross the port as data.
 * Proven against the hand-written type in both directions below.
 */
export const TurnOriginSchema = z.discriminatedUnion('kind', [
  bareOrigin('interactive'),
  bareOrigin('session-relay'),
  z.strictObject({ kind: z.literal('room'), externalAuthor: z.boolean() }),
  bareOrigin('schedule'),
  bareOrigin('relay-binding'),
  bareOrigin('agent-dm'),
  bareOrigin('outside-sender'),
  bareOrigin('connector-event'),
  z.strictObject({ kind: z.literal('agent-launch'), launchedBy: z.string().optional() }),
  bareOrigin('extension-start'),
  bareOrigin('extension-message'),
  bareOrigin('chat-message'),
  bareOrigin('account-handoff'),
  bareOrigin('account-resume'),
  bareOrigin('resume'),
  bareOrigin('heartbeat'),
  bareOrigin('test-harness'),
]);

/**
 * Compile-time proof that {@link TurnOriginSchema} and {@link TurnOrigin} name
 * the same members with the same fields, in both directions. Never evaluated.
 *
 * @internal
 */
type AssertTurnOrigin = [z.output<typeof TurnOriginSchema>] extends [TurnOrigin]
  ? [TurnOrigin] extends [z.input<typeof TurnOriginSchema>]
    ? true
    : never
  : never;
const _assertTurnOrigin: AssertTurnOrigin = true;
void _assertTurnOrigin;

/** Every {@link TurnOrigin} kind, read off the schema (17 today). */
export const TURN_ORIGIN_KINDS: readonly TurnOrigin['kind'][] = TurnOriginSchema.options.map(
  (option) => option.shape.kind.value
);

/** Where a turn came from, in the four words the agent-computer wire carries. */
export type WireOrigin = z.infer<typeof AgentComputerTurnOriginSchema>;

/**
 * The wire's coarse origin for a turn origin: `room` for a room turn, `task`
 * for a scheduled task's run, `beat` for a heartbeat, and `chat` for every
 * other surface, since each of those starts or continues a chat (spec §3.2).
 *
 * Exhaustive by construction: a new {@link TurnOrigin} member fails to compile
 * here until somebody decides which word it travels as.
 *
 * @param origin - What is starting the turn.
 * @returns The `turn.start` origin word.
 */
export function wireOriginOf(origin: TurnOrigin): WireOrigin {
  switch (origin.kind) {
    case 'room':
      return 'room';
    case 'schedule':
      return 'task';
    case 'heartbeat':
      return 'beat';
    case 'interactive':
    case 'session-relay':
    case 'relay-binding':
    case 'agent-dm':
    case 'outside-sender':
    case 'connector-event':
    case 'agent-launch':
    case 'extension-start':
    case 'extension-message':
    case 'chat-message':
    case 'account-handoff':
    case 'account-resume':
    case 'resume':
    case 'test-harness':
      return 'chat';
    default: {
      const unhandled: never = origin;
      throw new Error(`unhandled turn origin: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Whether a turn's words wait as a queue row a person can see, edit, reorder
 * and remove (spec §3.5): a person's own message, another chat's message, or
 * a mini app's message to an agent (`ctx.agent.send`). Every other origin's
 * words stay at their source (a room entry, a wake, a heartbeat raise) and
 * wait on the space side until the chat is free. On a Mac, a run
 * whose words wait in the composer skips admission's chat-busy check and is
 * queued as a row; any other run is handed over only when no live run holds
 * its chat, and the computer face refuses it `chat_busy` otherwise.
 *
 * @param origin - What is starting the turn.
 * @returns True when the words wait in the composer.
 */
export function wordsWaitInComposer(origin: TurnOrigin): boolean {
  return (
    origin.kind === 'interactive' ||
    origin.kind === 'session-relay' ||
    origin.kind === 'chat-message' ||
    origin.kind === 'extension-message'
  );
}

/**
 * Whether a person typed the words (here, or from the web through the
 * session relay): such a turn never counts toward the launch cap, and a
 * paused agent refuses it rather than holding it (spec §3.5).
 *
 * @param origin - What is starting the turn.
 */
export function personTyped(origin: TurnOrigin): boolean {
  return origin.kind === 'interactive' || origin.kind === 'session-relay';
}

// === Ids and references ===

/**
 * A run's id: a ULID minted by the space side (spec §4.1). Spelled like a Mesh
 * agent id, so it reuses that one pattern, and it fits the `dork:` id grammar.
 */
export const RunIdSchema = z.string().regex(AGENT_ID_PATTERN);

/**
 * A run's `dork:` reference: `dork:turn:<id>` (spec §12, choice 3).
 *
 * @param runId - The run's id.
 * @returns Its reference.
 * @throws {TypeError} When the id does not fit the `dork:` id grammar.
 */
export function runReference(runId: string): string {
  return formatDorkReference({ kind: 'turn', id: runId });
}

/** A `dork:<kind>:<id>` reference of a kind DorkOS mints (`@dorkos/shared/dork-ref`). */
const DorkReferenceSchema = z
  .string()
  .refine((value) => parseDorkReference(value).ok, { message: 'Not a dork: reference' });

/** Where a run's words wait: `<kind>:<id>`, a source kind and that source's own id. */
const SourceRefSchema = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z-]{0,31}:[^\s]{1,160}$/u, { message: 'Not a <kind>:<id> source' });

/** A chat, by its canonical id. */
const SessionIdSchema = z.string().min(1).max(200);

/** A moment, as epoch milliseconds. */
const EpochMsSchema = z.number().int().nonnegative();

// === Turn options ===

/** A teammate whose words started the chain (`TeammateOrigin`). */
const TeammateOriginSchema = z.strictObject({
  roomId: z.string().min(1),
  authorId: z.string().min(1),
});

/** A permission level as asking and reach (`TurnPermissionLevel`). */
const TurnPermissionLevelSchema = z.strictObject({
  asks: z.enum(['always', 'when-risky', 'never']),
  reach: z.enum(['read', 'edit', 'workspace', 'everything']),
  auto: z.literal(true).optional(),
  outsider: z.literal(true).optional(),
  teammate: z.array(TeammateOriginSchema).readonly().optional(),
});

/** One bound: a level, or the receiving runtime's own default (`TurnPermissionBound`). */
const TurnPermissionBoundSchema = z.union([
  TurnPermissionLevelSchema,
  z.literal('runtime-default'),
]);

/** The loosest level a turn may run at (`TurnPermissionCeiling`). */
const TurnPermissionCeilingSchema = z.union([
  TurnPermissionBoundSchema,
  z.array(TurnPermissionBoundSchema).readonly(),
]);

/** A folder a turn may reach beyond its cwd (`DirectoryGrant`). */
const DirectoryGrantSchema = z.strictObject({
  path: z.string().min(1),
  access: z.enum(['read', 'write']),
});

/** Per-turn execution settings the caller resolved itself (`DispatchMessageOpts.settings`). */
const TurnSettingsSchema = z.strictObject({
  model: SessionSettingsSchema.shape.model,
  effort: SessionSettingsSchema.shape.effort,
});

/**
 * Compile-time proof that the option schemas above carry the runtime's own
 * types, in both directions: what a schema parses can be handed to a runtime,
 * and what a caller holds today can be parsed. Never evaluated.
 *
 * @internal
 */
type AssertMirrors<S extends z.ZodType, T> = [z.output<S>] extends [T]
  ? [T] extends [z.input<S>]
    ? true
    : never
  : never;
const _assertCeiling: AssertMirrors<typeof TurnPermissionCeilingSchema, TurnPermissionCeiling> =
  true;
const _assertGrant: AssertMirrors<typeof DirectoryGrantSchema, DirectoryGrant> = true;
void _assertCeiling;
void _assertGrant;

/**
 * Work the computer side does when a turn LAUNCHES, named rather than passed
 * as a function (spec §3.2). A preparer registry on the computer side resolves
 * each kind.
 *
 * - `room-files`: refresh the room's worktree for the member before the turn
 *   runs (`contributing/architecture-target.md` §3 step 5), which today is the
 *   room runner's `prepareLaunch` function.
 */
export const TurnPreparationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('room-files'),
    /** The room whose files the turn works in. */
    roomId: z.string().min(1),
    /** The room member the turn runs as. */
    authorId: z.string().min(1),
  }),
]);

/** A named preparation. See {@link TurnPreparationSchema}. */
export type TurnPreparation = z.infer<typeof TurnPreparationSchema>;

/**
 * The fields of a turn that its caller decides, shared by both faces' inputs.
 * The space face adds nothing to them and the computer face reads them as
 * given.
 */
const callerTurnFields = {
  /** The chat, by its canonical id. */
  sessionId: SessionIdSchema,
  /**
   * The agent the turn runs as, by its Mesh id. Optional because a chat can
   * have none: a person may chat in a folder no Mesh agent is registered for
   * (`SendMessageRequest.agentPath` is optional), which is also why the run
   * record's `agent_id` is nullable (spec §4.1). The agent-computer wire's
   * `turn.start` requires one, so a request without it is only ever served by
   * this computer's own computer face, never sent to an agent computer.
   */
  agentId: RelayAgentIdSchema.optional(),
  /**
   * The directory the turn runs in, absolute. Absent, the chat runs where it
   * always has: an existing chat in its own folder, a new one wherever the
   * launch path's own ladder places it (an agent's home, else the default).
   */
  cwd: z.string().min(1).optional(),
  /**
   * The words, inline, as `turn.start` carries them: never empty, at most
   * `SESSION_RELAY_MAX_MESSAGE_LENGTH` (200,000) characters. Longer is
   * refused at parse, naming the cap, before anything is saved.
   */
  content: RelayMessageContentSchema,
  /** What is starting the turn. */
  origin: TurnOriginSchema,
  /**
   * The thing the turn came from, as a `dork:` reference (a room, a task run).
   * Optional for every origin here; the wire's own rule that a room, task or
   * beat turn names one is the wire's to apply.
   */
  originRef: DorkReferenceSchema.optional(),
  /** The tier the turn runs at, decided by the space side. */
  tier: AgentComputerTurnTierSchema,
  /** The loosest level the turn may run at. */
  permissionCeiling: TurnPermissionCeilingSchema.optional(),
  /** Standing instructions for the turn's system prompt. */
  systemPromptAppend: z.string().optional(),
  /** Folders the turn may reach beyond its cwd. Absent means none. */
  additionalDirectories: z.array(DirectoryGrantSchema).readonly().optional(),
  /** Work to do when the turn launches, by name. */
  prepare: TurnPreparationSchema.optional(),
  /** Model and effort, when the caller resolved them itself. */
  settings: TurnSettingsSchema.optional(),
  /**
   * The runtime a chat not bound yet starts on, by its type name (a caller
   * that checked an account rule for one runtime names it, so the chat runs
   * on that one). A name, never the `AgentRuntime` object. Ignored once the
   * chat is bound: the first write wins (ADR-0255).
   */
  runtime: z.string().min(1).optional(),
  /**
   * Background the turn's opener attaches to it (`SendMessageRequest.seedContext`):
   * one honest line so the model does not take the words for a person's own. It
   * rides the neutral context bag, never `content`, and is never drawn.
   */
  seedContext: z.string().min(1).max(SEED_CONTEXT_MAX_LENGTH).optional(),
};

// === Space face ===

/**
 * What a space-side caller hands the space face's `start()` (spec §3.1).
 *
 * The caller's turn fields, plus the two things only a caller can say about
 * waiting and billing. What the space face mints (`runId`, `attempt`), derives
 * (`wireOrigin`) or decides at admission (`accountRef`, `playbookId`) is not
 * here: it is added when the `start_turn` handler builds the
 * {@link TurnStartRequest}.
 *
 * Three record columns get their input fields with the callers that need
 * them: `sourceRef` with T5 (a mini app keeps its words in its own row),
 * `askedByRef` with T6, `startKey` with T7. The schema is strict, so adding an
 * optional field later changes nothing a caller sends today.
 */
export const StartTurnInputSchema = z.strictObject({
  ...callerTurnFields,
  /**
   * Where the words wait until the turn starts, when the caller keeps them in
   * a store of its own (spec §4.1, `source_ref`): `<kind>:<id>`, read back by
   * the source the kind's owner registered. Absent, the words live in this
   * process only until the turn starts, and a restart in between cancels the
   * run as `start_lost`. `content` still carries them, for the cap check.
   */
  sourceRef: SourceRefSchema.optional(),
  /**
   * Epoch ms. The run waits for its turn, and is cancelled as `expired` if it
   * has not started by then. Replaces `whenBusy: 'refuse'` (spec §3.2, §3.5).
   * Absent: it waits as long as the run ahead of it in its chat.
   */
  notAfter: EpochMsSchema.optional(),
  /**
   * The caller's account choice, which admission passes through as the
   * request's `accountRef` (spec §3.5; DOR-5190 replaces the choice).
   */
  accountHint: z.string().min(1).optional(),
});

/** What a caller hands `start()`. See {@link StartTurnInputSchema}. */
export type StartTurnInput = z.infer<typeof StartTurnInputSchema>;

/**
 * The space face's answer to `start()`, given at acceptance, never at turn
 * start (spec §3.1). `queuePosition` is 1-based, as the message receipt's is:
 * 1 means nothing of this chat is ahead of it.
 */
export const StartTurnResultSchema = z.strictObject({
  runId: RunIdSchema,
  status: RunStatusSchema,
  queuePosition: z.number().int().positive(),
});

/** The space face's answer. See {@link StartTurnResultSchema}. */
export type StartTurnResult = z.infer<typeof StartTurnResultSchema>;

// === Computer face ===

/**
 * What the space face hands the computer face (spec §3.2): the caller's turn
 * fields, plus the run's identity and what admission decided. A queue row id,
 * `source_ref` or effect id is a space-side detail and never appears here.
 */
export const TurnStartRequestSchema = z
  .strictObject({
    /** The run this turn is an attempt of. */
    runId: RunIdSchema,
    /** 1 for a new turn; one more than the run it continues otherwise. */
    attempt: z.number().int().min(1),
    /** The run this attempt continues after a restart (§7.3). Present exactly when `attempt` > 1. */
    continuesRunId: RunIdSchema.optional(),
    ...callerTurnFields,
    /** The wire's word for `origin`; always `wireOriginOf(origin)`. */
    wireOrigin: AgentComputerTurnOriginSchema,
    /** The account the turn runs on, as admission chose it (§3.5). */
    accountRef: z.string().min(1).optional(),
    /**
     * The playbook the turn starts under (DOR-5187). Absent, never `null`:
     * when admission answers "no playbook" (spec §3.5 writes it `null`), the
     * `start_turn` handler leaves the field out, so "none" has one spelling on
     * the port and on the wire. Admission's own type follows (T5).
     */
    playbookId: z.string().min(1).optional(),
  })
  .refine((request) => request.wireOrigin === wireOriginOf(request.origin), {
    message: 'wireOrigin must be wireOriginOf(origin)',
    path: ['wireOrigin'],
  })
  .refine((request) => (request.attempt === 1) === (request.continuesRunId === undefined), {
    message: 'A first attempt continues nothing; a later attempt names the run it continues',
    path: ['continuesRunId'],
  });

/** What the computer face is asked to start. See {@link TurnStartRequestSchema}. */
export type TurnStartRequest = z.infer<typeof TurnStartRequestSchema>;

/**
 * Why the computer face refused a start (spec §3.1). It has no "waiting"
 * answer: waiting is decided on the space side before the computer face is
 * asked (spec §3.5). Closed: each reason says what happens to the run.
 *
 * - `already_held`: the computer side already holds THIS `runId`: a repeated
 *   start (§6.2), or a hand-over racing a launch the dispatcher still holds.
 *   No second turn starts and no transition is written: the run keeps its
 *   status, and the `start_turn` handler keeps waiting for the `started`
 *   fact. It is not answered as `accepted`.
 * - `chat_busy`: a live run of the chat holds it, and this run's words stay
 *   at their source (no queue row). The run stays `queued` (on a Mac it never
 *   left it; for a remote computer the handler writes transition 8), and the
 *   handler tries again with backoff, without counting attempts, bounded by
 *   the run's `notAfter`. Words that belong in a composer are queued as a row
 *   instead and never refused for a busy chat, and a chat busy with no run
 *   behind it (a summary, an open ask) is never `chat_busy`.
 * - `agent_paused`: the agent is paused and the turn is a person's own chat.
 *   The caller sees today's `AGENT_PAUSED` refusal (§3.5).
 * - The door's own refusals, each answered before the chat is bound or
 *   anything is queued (`launch-session.ts`): `invalid_agent_path` (no
 *   registered agent there), `unknown_runtime`, `room_session_moved` (a room
 *   conversation kept in the room's files), `desk_not_own` (the turn would
 *   stand in a room's files, or in a folder that is not its agent's), and
 *   `account_not_allowed` (the account may not work in this project).
 * - `runtime_mismatch`: the start asked for one runtime, and its agent's home
 *   is placed on a computer that runs another (`COMPUTER_RUNTIME_MISMATCH` in
 *   `launch-session.ts`). Asking again cannot change that, so it is a refusal,
 *   not a failure retried with backoff.
 *
 * Every reason but `already_held` and `chat_busy` cancels the run, with the
 * reason kept in `ending_detail`. None is ever carried as `ended` with
 * `refused`, which stays the runtime's own refusal (DOR-2994).
 *
 * Where a refusal cancels from depends on who writes `queued` → `starting`.
 * On a Mac the dispatcher hook writes it when the launch begins, so a door
 * refusal cancels the run from `queued` (row 5). For a remote computer the
 * space side has already written `starting`, so it cancels from `starting`
 * (row 9).
 */
export const RefusalReasonSchema = z.enum([
  'already_held',
  'chat_busy',
  'agent_paused',
  'invalid_agent_path',
  'unknown_runtime',
  'room_session_moved',
  'desk_not_own',
  'account_not_allowed',
  'runtime_mismatch',
]);

/** Why a start was refused. See {@link RefusalReasonSchema}. */
export type RefusalReason = z.infer<typeof RefusalReasonSchema>;

/** The computer face's answer to a {@link TurnStartRequest}: accepted, or refused with a reason. */
export const TurnStartAnswerSchema = z.union([
  z.strictObject({ accepted: z.literal(true) }),
  z.strictObject({ refused: RefusalReasonSchema }),
]);

/** The computer face's answer. See {@link TurnStartAnswerSchema}. */
export type TurnStartAnswer = z.infer<typeof TurnStartAnswerSchema>;

// === Facts ===

/** Why a run exists: a new turn, or a continuation after a restart (spec §4.1). */
export const AttemptReasonSchema = z.enum(['initial', 'restart']);

/** Why a run exists. See {@link AttemptReasonSchema}. */
export type AttemptReason = z.infer<typeof AttemptReasonSchema>;

/** One piece of background work a run's process holds: its kind and a label (spec §7.4). */
const BackgroundWorkEntrySchema = z.strictObject({
  kind: BackgroundTaskTypeSchema,
  label: z.string().min(1),
});

/**
 * What the computer face reports about a run, through the one sink registered
 * at startup (spec §3.1). Each fact names its run by `runId`.
 *
 * - `accepted`: the computer face took the start of `runId`. `joinedRunId`
 *   names ANOTHER run whose words were still `queued` and joined this run's
 *   turn (a drain join); that other run goes `queued` → `superseded` (§4.3
 *   row 6). It never names the asked run itself: a chat has one live run
 *   (§5) and the launch gate passes only its earliest unfinished run (§7.5),
 *   so the run being started is never the one superseded. Several joined
 *   runs are several `accepted` facts, one each.
 * - `started`: `turn_start` was ingested; `runtime`, `runtimeTurnRef` (the
 *   `seq` of `turn_start`) and `turnBindingId` feed the record's columns.
 *   `openedBy: 'runtime'` is a turn the runtime opened on its own (§4.3
 *   row 2): no caller asked, so the computer side mints its `runId` (a ULID)
 *   and the fact carries `sessionId`, and `agentId` when the chat has a Mesh
 *   agent (a chat may have none, so the record's `agent_id` is nullable,
 *   §4.1). The space side inserts
 *   the run if it is absent; a repeat of the fact is the same row; an id that
 *   already exists for another chat is refused.
 * - `delivered`: the runtime's first event for the turn arrived.
 * - `waiting_on_person`, `resumed_from_person`: an ask opened, and closed.
 * - `background_work`: the work the run's process holds now, the whole list.
 * - `ended`: the turn ended. DorkOS never writes an ending it did not observe
 *   (ADR 260823-021312), so a `stopped` ending needs proof: a `receipt` whose
 *   outcome is `acked` or `closed` (the stop itself ended the turn), or
 *   `interrupted: true`, the runtime's own `turn_end` reporting an interrupt.
 *   Not `not-running`: `turnEnded()` is true for it, but the turn had already
 *   finished on its own, and calling it stopped would relabel that ending.
 *   An `unconfirmed` receipt alone is not proof: after an unconfirmed stop, a
 *   plain `turn_end` ends the run as the runtime reports it (`completed`,
 *   `failed`, `limited`). A `failed` receipt never makes a `stopped` ending.
 *   Any ending may carry `stopRequest`, a stop that was asked for and what
 *   its receipt said, so the record keeps an unconfirmed request; a
 *   `stopped` ending may also name who stopped it (`stoppedBy`). A `refused`
 *   ending may carry the runtime's words.
 */
export const RunFactSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('accepted'),
      runId: RunIdSchema,
      joinedRunId: RunIdSchema.optional(),
    })
    .refine((fact) => fact.joinedRunId !== fact.runId, {
      message: 'A joined run is another run, never the one being started',
      path: ['joinedRunId'],
    }),
  z.strictObject({
    kind: z.literal('started'),
    runId: RunIdSchema,
    sessionId: SessionIdSchema,
    openedBy: z.enum(['caller', 'runtime']),
    /** The agent, by its Mesh id, when the chat has one. */
    agentId: RelayAgentIdSchema.optional(),
    runtime: z.string().min(1),
    runtimeTurnRef: z.number().int().nonnegative(),
    turnBindingId: z.string().min(1).optional(),
    /**
     * What the launch owes a person to know about this chat, in plain words
     * (`SessionLaunchWarning`): today only that an agentless Codex chat has no
     * DorkOS tools. The run keeps them, for every device to show (T3).
     */
    warnings: z.array(z.strictObject(SessionLaunchWarningSchema.shape)).readonly().optional(),
  }),
  z.strictObject({ kind: z.literal('delivered'), runId: RunIdSchema }),
  z.strictObject({ kind: z.literal('waiting_on_person'), runId: RunIdSchema }),
  z.strictObject({ kind: z.literal('resumed_from_person'), runId: RunIdSchema }),
  z.strictObject({
    kind: z.literal('background_work'),
    runId: RunIdSchema,
    work: z.array(BackgroundWorkEntrySchema).readonly(),
  }),
  z
    .strictObject({
      kind: z.literal('ended'),
      runId: RunIdSchema,
      ending: RunEndingSchema,
      /**
       * The stop's receipt (ADR 260823-021312's vocabulary), strict as every
       * port object is. Only on a `stopped` ending.
       */
      receipt: z.strictObject(InterruptReceiptSchema.shape).optional(),
      /** The runtime's own `turn_end` reported an interrupt. Only on a `stopped` ending. */
      interrupted: z.literal(true).optional(),
      /** Who stopped it, as a `dork:` reference. Only on a `stopped` ending. */
      stoppedBy: DorkReferenceSchema.optional(),
      /**
       * A stop that was asked for during the turn, whatever the ending: who
       * asked, and what its receipt said. How the record keeps an
       * `unconfirmed` request on a turn that then ended on its own.
       */
      stopRequest: z
        .strictObject({
          by: DorkReferenceSchema.optional(),
          outcome: InterruptReceiptSchema.shape.outcome,
        })
        .optional(),
      refusal: z.string().min(1).optional(),
    })
    .refine((fact) => fact.ending === 'stopped' || fact.receipt === undefined, {
      message: 'Only a stopped ending carries a receipt; use stopRequest otherwise',
      path: ['receipt'],
    })
    .refine((fact) => fact.ending === 'stopped' || fact.interrupted === undefined, {
      message: 'Only a stopped ending reports an interrupt',
      path: ['interrupted'],
    })
    .refine((fact) => fact.receipt?.outcome !== 'failed', {
      message: 'A failed stop never ends a run as stopped',
      path: ['receipt'],
    })
    .refine(
      (fact) =>
        fact.ending !== 'stopped' ||
        fact.interrupted === true ||
        fact.receipt?.outcome === 'acked' ||
        fact.receipt?.outcome === 'closed',
      {
        message:
          "A stopped ending needs an acked or closed stop receipt, or the runtime's own interrupt",
        path: ['ending'],
      }
    )
    .refine((fact) => fact.stoppedBy === undefined || fact.ending === 'stopped', {
      message: 'Only a stopped ending names who stopped it',
      path: ['stoppedBy'],
    })
    .refine((fact) => fact.refusal === undefined || fact.ending === 'refused', {
      message: "Only a refused ending carries the runtime's refusal",
      path: ['refusal'],
    }),
]);

/** One fact about a run. See {@link RunFactSchema}. */
export type RunFact = z.infer<typeof RunFactSchema>;

// === Transitions ===

/** One legal move of a run's status; `from: null` creates the run. */
export interface RunTransition {
  /**
   * The row of the spec's table (§4.3), for tracing a write back to its rule.
   * Rows 14 and 15 are the architect's additions to that table.
   */
  readonly row: number;
  /** The status before, or `null` when the write creates the run. */
  readonly from: RunStatus | null;
  /** The status after. */
  readonly to: RunStatus;
}

/**
 * The fifteen legal transitions (spec §4.3, plus rows 14 and 15); every other
 * pair is illegal. `starting` → `superseded` is one of the illegal ones.
 * The run store checks each write against this table and throws on a pair it
 * does not hold.
 */
export const RUN_TRANSITIONS: readonly RunTransition[] = [
  { row: 1, from: null, to: 'queued' },
  { row: 2, from: null, to: 'running' },
  { row: 3, from: 'queued', to: 'queued' },
  { row: 4, from: 'queued', to: 'starting' },
  { row: 5, from: 'queued', to: 'cancelled' },
  // Only from `queued`: a run whose words joined another run's turn. Never
  // from `starting` (see the `accepted` fact's `joinedRunId`).
  { row: 6, from: 'queued', to: 'superseded' },
  { row: 7, from: 'starting', to: 'started' },
  { row: 8, from: 'starting', to: 'queued' },
  { row: 9, from: 'starting', to: 'cancelled' },
  { row: 10, from: 'started', to: 'running' },
  { row: 11, from: 'started', to: 'ended' },
  { row: 12, from: 'running', to: 'ended' },
  { row: 13, from: 'ended', to: 'settled' },
  // A pause that cuts the turn before the agent did anything puts its row back
  // on the queue, held (DOR-4353, `holdStartedForPause` in
  // `apps/server/src/services/session/message-dispatcher/pause-hold.ts`).
  { row: 14, from: 'started', to: 'queued' },
  { row: 15, from: 'running', to: 'queued' },
];

/** The statuses no transition leaves (spec §4.3). */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['settled', 'cancelled', 'superseded'];

/**
 * Whether a run may move from one status to another.
 *
 * @param from - The status before, or `null` for a run being created.
 * @param to - The status after.
 * @returns True only for a pair in {@link RUN_TRANSITIONS}.
 */
export function canTransition(from: RunStatus | null, to: RunStatus): boolean {
  return RUN_TRANSITIONS.some((transition) => transition.from === from && transition.to === to);
}
