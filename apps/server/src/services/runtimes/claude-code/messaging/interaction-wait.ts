/**
 * One prompt's WAIT: what is pending, how long it is held, and what everybody is
 * told at each stage of it.
 *
 * Split out of `interactive-handlers.ts`, which owns the three SDK callbacks
 * that raise a prompt, so that the two-stage wait those callbacks share
 * (spec `ask-parks-on-timeout`) is defined exactly once and read in one place:
 * the pending-entry shapes, the park and refusal timers, the operator-facing
 * sentences, and the two log lines.
 *
 * **The wait is two stages, and only the second one refuses.** A prompt counts
 * down for {@link SESSIONS.INTERACTION_TIMEOUT_MS} exactly as it always has. Past
 * that it PARKS: the promise stays unresolved, the tool call stays held, the SDK
 * holds its loop open (`sdk.d.ts:196-205`), and the person is told the agent is
 * waiting. Only at {@link SESSIONS.INTERACTION_PARK_CEILING_MS} is the model
 * handed a refusal. An unattended run is the exception and refuses at the
 * countdown, because nobody is coming back to it.
 *
 * @module runtimes/claude-code/messaging/interaction-wait
 */
import type {
  ElicitationRequest,
  ElicitationResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type { AlwaysAllowScope, StreamEvent, QuestionItem } from '@dorkos/shared/types';
import { logRefusal } from '../../../observability/refusals.js';
import { logger } from '../../../../lib/logger.js';
import { SESSIONS } from '../../../../config/constants.js';
import { describeWaited } from '../sessions/tool-result-outcome.js';

// ---------------------------------------------------------------------------
// Pending interaction snapshots (serializable re-emit payloads)
// ---------------------------------------------------------------------------

/**
 * Serializable snapshot of an `approval_required` event's `data`, minus the
 * routing `toolCallId`. A recovery path rebuilds the native client event from
 * this snapshot without holding the live SDK approval closure.
 */
export interface ApprovalSnapshot {
  toolName: string;
  /** JSON-stringified tool input, matching the in-band `approval_required` payload. */
  input: string;
  title?: string;
  displayName?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
  hasSuggestions: boolean;
  /**
   * How far an accepted "Always Allow" reaches, so a card rebuilt on recovery
   * names the same scope the live one did (DOR-1462). Absent when the prompt
   * carried no suggestions — there is no button to describe.
   */
  alwaysAllowScope?: AlwaysAllowScope;
}

/**
 * Serializable snapshot of a `question_prompt` event's `data`, minus the
 * routing `toolCallId`. Re-emitted verbatim on recovery.
 */
export interface QuestionSnapshot {
  questions: QuestionItem[];
}

/**
 * Serializable snapshot of an `elicitation_prompt` event's `data`, minus the
 * routing `interactionId`. Re-emitted verbatim on recovery.
 */
export interface ElicitationSnapshot {
  serverName: string;
  message: string;
  mode?: ElicitationRequest['mode'];
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pending interaction types (discriminated union for type safety)
// ---------------------------------------------------------------------------

interface PendingApproval {
  type: 'approval';
  toolCallId: string;
  /**
   * Answer the ask. `denyReason` is the person's own words, forwarded to the
   * model as the refusal message when they refused and said why; it is ignored
   * for an approval, which has nothing to explain.
   */
  resolve: (result: boolean | PermissionUpdate[], denyReason?: string) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** SDK permission suggestions for "Always Allow" — stored so session-store can forward them. */
  suggestions?: PermissionUpdate[];
  /** Server epoch ms when this interaction began (for recovery countdown math). */
  startedAt: number;
  /** Serializable re-emit payload for the recovery path. */
  snapshot: ApprovalSnapshot;
}

interface PendingQuestion {
  type: 'question';
  toolCallId: string;
  resolve: (answers: Record<string, string>) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** Server epoch ms when this interaction began (for recovery countdown math). */
  startedAt: number;
  /** Serializable re-emit payload for the recovery path. */
  snapshot: QuestionSnapshot;
}

interface PendingElicitation {
  type: 'elicitation';
  toolCallId: string;
  resolve: (result: ElicitationResult) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** Server epoch ms when this interaction began (for recovery countdown math). */
  startedAt: number;
  /** Serializable re-emit payload for the recovery path. */
  snapshot: ElicitationSnapshot;
}

export type PendingInteraction = PendingApproval | PendingQuestion | PendingElicitation;

/** Minimal session interface needed by interactive handlers. */
export interface InteractiveSession {
  pendingInteractions: Map<string, PendingInteraction>;
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
  /**
   * What this session is called, for the log and nothing else.
   *
   * Optional because the handlers in `interactive-handlers.ts` work perfectly
   * well without it and a
   * test fake should not have to invent one — but a real `AgentSession` always
   * carries it, so the one line that matters
   * ({@link logInteractionTimeout}) can name the session a person has to open.
   */
  sdkSessionId?: string;
  /**
   * The session's working directory — the ONLY thing the in-session surface
   * resolves an agent identity from, and therefore what decides who the
   * owner-facing verbs act as (`IDENTITY_SCOPED_TOOLS` in
   * `interactive-handlers.ts`).
   *
   * Optional for the same reason `sdkSessionId` is: a real `AgentSession`
   * always carries it, a test fake need not. Absent means no identity, which is
   * the conservative answer — those verbs ask rather than skip the card.
   */
  cwd?: string;
  /**
   * True when nobody is watching this session — a scheduled task run.
   *
   * A prompt in such a session refuses at
   * {@link SESSIONS.INTERACTION_TIMEOUT_MS} and never parks, because a park is
   * a promise that somebody will come back and there is nobody here to keep it.
   * Waiting four hours per ask would stall the run rather than protect anyone
   * (spec `ask-parks-on-timeout` §7). Absent means a person may well be
   * watching, which is the setting every interactive session runs under.
   */
  unattended?: boolean;
}

/**
 * Say that nobody answered, so this was denied.
 *
 * **The only DURABLE trace an expired prompt leaves.** All three handlers in
 * `interactive-handlers.ts` hand the model a denial once the wait runs out —
 * four hours for a session somebody could come back to, ten minutes for an
 * unattended run — and, until DOR-1158, wrote nothing anywhere: the card vanished from any
 * client that happened to be watching, the turn carried on as though a person
 * had refused, and there was no record that the refusal was a clock rather
 * than a decision. On 2026-07-31 two agents hit this twice each, invisibly,
 * inside one forty-one minute silence (DOR-784) — and reconstructing that
 * afterwards took the SDK transcripts, because the server log had nothing.
 *
 * DOR-1158 added a companion live notice ({@link notifyInteractionTimeoutNotice})
 * naming what expired, but it rides the transient status strip: the next turn
 * event clears it, so it only reaches an operator watching THIS session at THIS
 * moment. This log line is still what survives for anyone who checks back
 * later — the durability gap DOR-1158 did not close.
 *
 * `warn`, not `info`: work was thrown away that a person would probably have
 * approved. Nothing from the prompt's INPUT is logged — a tool's arguments are
 * file paths, commands and occasionally secrets — only what it was and how long
 * it waited.
 *
 * @param session - The session whose turn was blocked.
 * @param interaction.id - The interaction's id (the tool-use id, for a tool).
 * @param interaction.kind - Which of the three kinds of prompt expired.
 * @param interaction.toolName - The tool an approval was about, when there is one.
 * @param interaction.waitedMs - How long the prompt actually went unanswered.
 */
function logInteractionTimeout(
  session: InteractiveSession,
  interaction: {
    id: string;
    kind: 'approval' | 'question' | 'elicitation';
    toolName?: string;
    waitedMs: number;
  }
): void {
  logRefusal(
    `[claude-code] nobody answered in ${describeWaited(interaction.waitedMs)}, so this was denied`,
    {
      reason: 'interaction_expired',
      // `silent` because nothing DURABLE is written for an expired prompt: the
      // companion live notice (DOR-1158) is best-effort and clears with the next
      // turn event, so this log line is still the only record an operator who
      // checks back later can find. See this function's TSDoc.
      visibility: 'silent',
      ...(session.sdkSessionId !== undefined ? { sessionId: session.sdkSessionId } : {}),
      detail: {
        interactionId: interaction.id,
        kind: interaction.kind,
        toolName: interaction.toolName,
        waitedMs: interaction.waitedMs,
      },
    }
  );
}

/**
 * Say that the countdown ran out and the agent is now waiting.
 *
 * `info`, not `warn`: nothing was thrown away. This is the line that makes a
 * long silence explainable to somebody reading the log later — the durability
 * gap DOR-1158 named — and unlike {@link logInteractionTimeout} it reports a
 * state rather than a loss. Nothing from the prompt's INPUT is logged, for the
 * reason its sibling gives.
 *
 * @param session - The session holding the prompt.
 * @param interaction.id - The interaction's id (the tool-use id, for a tool).
 * @param interaction.kind - Which of the three kinds of prompt parked.
 * @param interaction.toolName - The tool an approval was about, when there is one.
 */
function logInteractionParked(
  session: InteractiveSession,
  interaction: { id: string; kind: 'approval' | 'question' | 'elicitation'; toolName?: string }
): void {
  logger.info('[claude-code] nobody answered in time, so the agent is waiting', {
    interactionId: interaction.id,
    kind: interaction.kind,
    toolName: interaction.toolName,
    ...(session.sdkSessionId !== undefined ? { sessionId: session.sdkSessionId } : {}),
    // The whole wait, measured from `startedAt` — not what is left of it.
    waitsForMs: SESSIONS.INTERACTION_PARK_CEILING_MS,
  });
}

/**
 * Push an `interaction_cancelled` StreamEvent so the projection drops a pending
 * card that was resolved WITHOUT an operator action (SDK abort or timeout).
 * Flows through the same eventQueue → normalizer → projector path as the
 * prompt events themselves, so every `/events` consumer (and the next
 * snapshot) sees the card disappear instead of an answerable ghost lingering
 * until expiry (acceptance run 20260610-173202, F5).
 */
export function notifyInteractionCancelled(
  session: InteractiveSession,
  interactionId: string,
  reason: 'aborted' | 'timeout'
): void {
  session.eventQueue.push({
    type: 'interaction_cancelled',
    data: { interactionId, reason },
  });
  session.eventQueueNotify?.();
}

/**
 * How long an operator has to answer, in whole minutes — for prose that names
 * the wait (e.g. "waited 10 minutes"), derived from the same constant the
 * timeout itself uses so the two can never drift apart.
 */
const INTERACTION_TIMEOUT_MINUTES = Math.ceil(SESSIONS.INTERACTION_TIMEOUT_MS / 60_000);

/** Shorten a snippet of user-facing prose to roughly `maxLength` characters. */
function truncateForNotice(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength).trimEnd()}…` : trimmed;
}

/**
 * Push a `system_status` StreamEvent telling the operator what expired
 * unanswered.
 *
 * **Best-effort, not durable.** This rides the same transient channel as the
 * phantom-cancellation notice in `message-sender.ts`: the client's status
 * strip shows it only until the next turn event, which — because `resolve`
 * unblocks the SDK right after this call — typically arrives within one more
 * server-sent event. It reaches an operator watching THIS session at THIS
 * moment; it does not persist for one who reconnects later. {@link
 * logInteractionTimeout} is still the only record that survives that case
 * (see its TSDoc) — closing that gap would mean a durable receipt, which is
 * out of scope here.
 *
 * **Timeout only.** A person resolving the prompt, or the SDK aborting it
 * (steer/interrupt), isn't a silence and gets no notice — call this only from
 * the `setTimeout` branch, never from `resolve`/`reject`/`onAbort`.
 *
 * **Ordering.** Always call this AFTER {@link notifyInteractionCancelled} for
 * the same interaction: both land in the same `eventQueue` frame, and if the
 * card's removal were pushed second it could be re-derived over this notice
 * before a client ever sees it — the same hazard the phantom-cancellation
 * notice in `message-sender.ts` documents for its own ordering.
 *
 * **No tool input.** `message` must be built from names and question text
 * only — never a tool's raw arguments or an elicitation's request body, both
 * of which can carry secrets.
 */
function notifyInteractionTimeoutNotice(session: InteractiveSession, message: string): void {
  session.eventQueue.push({ type: 'system_status', data: { message } });
  session.eventQueueNotify?.();
}

/** The operator-facing notice for an AskUserQuestion nobody has answered yet. */
export function questionParkedNotice(questions: QuestionItem[]): string {
  const base = `I asked you something ${INTERACTION_TIMEOUT_MINUTES} minutes ago and nobody has answered, so I am waiting here.`;
  const first = questions[0]?.question;
  return first ? `${base} The question was: "${truncateForNotice(first, 120)}"` : base;
}

/**
 * The operator-facing notice for an AskUserQuestion nobody ever answered.
 *
 * @param waited - How long the agent waited, in words.
 */
export function questionTimeoutNotice(waited: string): string {
  return `I waited ${waited} for an answer and nobody came, so I moved on.`;
}

/**
 * The label to name a tool by in operator-facing prose: the SDK's own
 * `displayName` when it gave a non-blank one, else the raw tool name. Guards
 * against an empty-string `displayName` producing "I asked to run  and
 * waited…" — `??` alone only catches `undefined`, not `""`.
 */
export function toolLabelFor(displayName: string | undefined, toolName: string): string {
  return displayName?.trim() ? displayName : toolName;
}

/** The operator-facing notice for a tool approval nobody has answered yet. */
export function approvalParkedNotice(toolLabel: string): string {
  return `I asked to run ${toolLabel} and nobody has answered yet, so I am waiting here until somebody does.`;
}

/**
 * The operator-facing notice for a tool approval nobody ever answered.
 *
 * @param toolLabel - What the tool is called, in the agent's own prose.
 * @param waited - How long the agent waited, in words.
 */
export function approvalTimeoutNotice(toolLabel: string, waited: string): string {
  return `I waited ${waited} for an answer about ${toolLabel} and nobody came, so I treated it as declined.`;
}

/** The operator-facing notice for an MCP elicitation nobody has answered yet. */
export function elicitationParkedNotice(serverName: string): string {
  return `${serverName} asked you something and nobody has answered yet, so I am waiting here until somebody does.`;
}

/**
 * The operator-facing notice for an MCP elicitation nobody ever answered.
 *
 * @param serverName - The MCP server that asked.
 * @param waited - How long the agent waited, in words.
 */
export function elicitationTimeoutNotice(serverName: string, waited: string): string {
  return `${serverName} asked you something. I waited ${waited} and nobody came, so I declined on your behalf.`;
}

/**
 * How long a prompt in this session goes unanswered before it is refused.
 *
 * Four hours for a session somebody could still come back to, and the plain
 * countdown for an unattended run, which never parks (spec
 * `ask-parks-on-timeout` §7). Every sentence that names the wait — the two
 * denials the model reads, the notice the operator sees, the log line — is
 * built from this number, so none of them can claim a wait that did not happen.
 *
 * **A relay-bound turn is NOT unattended here, and that is a decision.**
 * `core/unattended-autonomy` counts two unattended drivers, a binding and a
 * scheduled task, and only the scheduler passes this flag. The difference is
 * whether anybody can still answer: a scheduled run's prompt reaches nobody,
 * while a bridged agent's prompt is listed fleet-wide and is answerable from
 * the cockpit by the same person the room is talking to.
 *
 * **Many of them are answerable from the chat itself, and this used to claim
 * otherwise** (DOR-1440). There are two relay paths and they carry different
 * rules, which is what the old "cockpit only" sentence flattened away:
 *
 * - **Direct-bound** — an agent addressed over the relay. Its
 *   `approval_required` is published straight to the envelope's `replyTo`
 *   (`relay/adapters/claude-code/publish.ts`), enriched with the agent and
 *   session ids so the adapter can encode them in button values; Slack and
 *   Telegram render real Approve/Deny buttons for it. There is no chat-shape
 *   restriction at all — a group channel gets the card — and the approver
 *   allowlist is enforced at the CLICK (`mayApprove` in each adapter), not at
 *   the send.
 * - **Room-bound** — an agent answering for a room through a bridge.
 *   `chat-bridge/ask-card.ts` sends the same card, under much tighter rules,
 *   because that card carries the Ask's DETAIL into a chat DorkOS does not own
 *   the roster of: only an `approval`, only into a live one-to-one DM whose
 *   single outside member arrived through THIS adapter instance and is on its
 *   approver allowlist (`chat-bridge/ask-audience.ts`), and with `initiate`
 *   provenance so an operator who switched that off receives none. Everything
 *   else — a group chat, a question, an elicitation, a card the consent gate
 *   refuses — gets only the room's waiting sentence and is answered in the
 *   cockpit.
 *
 * Either way the wait is the same wait; what differs is how many places can end
 * it.
 *
 * @param session - The session holding the prompt.
 */
export function refusalDeadlineMs(session: InteractiveSession): number {
  return session.unattended === true
    ? SESSIONS.INTERACTION_TIMEOUT_MS
    : SESSIONS.INTERACTION_PARK_CEILING_MS;
}

/**
 * Arm the two-stage wait for one prompt: park at
 * {@link SESSIONS.INTERACTION_TIMEOUT_MS}, refuse at
 * {@link SESSIONS.INTERACTION_PARK_CEILING_MS}.
 *
 * Parking is not a resolution. Nothing is handed to the model, the tool call
 * stays held, and the SDK holds its loop open for as long as the promise stays
 * unresolved (`sdk.d.ts:196-205`). What happens at ten minutes is a sentence to
 * the operator, a log line, and a second timer.
 *
 * **The returned timer is the FIRST one.** It is stored on the pending entry as
 * `timeout` and REPLACED there when it fires, so anything that cancels the wait
 * must read the entry rather than close over this value — see
 * {@link clearInteractionTimer}. Closing over it was the shape that let a
 * cancelled prompt leave its ceiling timer armed to refuse an interaction that
 * had already been answered.
 *
 * **An unattended session never parks.** A scheduled run has nobody coming back
 * to it, so waiting four hours would only stall the run; it refuses at the
 * countdown exactly as it does today ({@link refusalDeadlineMs}).
 *
 * @param session - The session holding the prompt.
 * @param interactionId - The pending entry's key.
 * @param notices - What to say to the operator at each stage.
 * @param log - What kind of prompt this is, for the log.
 * @param refuse - Hands the model its refusal and settles the prompt. It owns
 *   detaching the SDK abort listener too, because only the caller holds it.
 * @returns The first stage's timer, for the entry's `timeout` slot.
 */
export function armInteractionWait(
  session: InteractiveSession,
  interactionId: string,
  notices: { parked: string; expired: string },
  log: { kind: 'approval' | 'question' | 'elicitation'; toolName?: string },
  refuse: () => void
): ReturnType<typeof setTimeout> {
  const expire = (): void => {
    session.pendingInteractions.delete(interactionId);
    logInteractionTimeout(session, {
      id: interactionId,
      ...log,
      waitedMs: refusalDeadlineMs(session),
    });
    notifyInteractionCancelled(session, interactionId, 'timeout');
    notifyInteractionTimeoutNotice(session, notices.expired);
    refuse();
  };

  if (session.unattended === true) {
    const only = setTimeout(expire, SESSIONS.INTERACTION_TIMEOUT_MS);
    only.unref?.();
    return only;
  }

  const park = (): void => {
    // Answered inside the same tick this timer fired: there is nothing left to
    // say, and saying it would push a notice over a card that is already gone.
    const entry = session.pendingInteractions.get(interactionId);
    if (entry === undefined) return;
    logInteractionParked(session, { id: interactionId, ...log });
    notifyInteractionTimeoutNotice(session, notices.parked);
    // The REMAINDER, not a fresh ceiling, so the deadline is
    // `startedAt + INTERACTION_PARK_CEILING_MS` — the same instant
    // `listPendingInteractions` measures against, which is what stops the card
    // and the server disagreeing about when the wait ends.
    const ceiling = setTimeout(
      expire,
      SESSIONS.INTERACTION_PARK_CEILING_MS - SESSIONS.INTERACTION_TIMEOUT_MS
    );
    ceiling.unref?.();
    entry.timeout = ceiling;
    // No `interaction_cancelled`, no resolution, no deny: the entry stays in
    // `session.pendingInteractions` and the promise stays unresolved.
  };

  const countdown = setTimeout(park, SESSIONS.INTERACTION_TIMEOUT_MS);
  // A wait must never hold the event loop open, the reason `PendingApprovalStore`
  // already gives for its own timer.
  countdown.unref?.();
  return countdown;
}

/**
 * Cancel whichever stage of a prompt's wait is currently armed.
 *
 * Reads the timer off the entry rather than a captured local, because
 * {@link armInteractionWait} REPLACES it when the prompt parks. A closure over
 * the first timer clears a timer that has already fired and leaves the ceiling
 * armed on an interaction nobody is waiting for.
 *
 * Call it BEFORE deleting the entry, or there is nothing left to read.
 *
 * @param session - The session holding the prompt.
 * @param interactionId - The pending entry's key.
 */
export function clearInteractionTimer(session: InteractiveSession, interactionId: string): void {
  const entry = session.pendingInteractions.get(interactionId);
  if (entry !== undefined) clearTimeout(entry.timeout);
}
