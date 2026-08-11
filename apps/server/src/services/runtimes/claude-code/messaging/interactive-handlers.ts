import type {
  PermissionResult,
  PermissionUpdate,
  ElicitationRequest,
  ElicitationResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, QuestionItem } from '@dorkos/shared/types';
import { UI_COMMAND_REACH, UiCommandSchema } from '@dorkos/shared/schemas';
import type { PermissionMode } from '@dorkos/shared/schemas';
import { logRefusal } from '../../../observability/refusals.js';
import { SESSIONS } from '../../../../config/constants.js';
import { toSdkQuestionAnswers } from '../sessions/question-answers.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Auto-approved tool sets (module-level to avoid per-call reconstruction)
// ---------------------------------------------------------------------------

/** Read-only Claude Code tools — cannot modify filesystem or execute shell commands. */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebSearch',
  'WebFetch',
]);

/**
 * DorkOS agent communication tools, auto-approved because they carry their own
 * authorization, NOT because they are read-only. Some of these mutate:
 * `relay_inbox` with `ack: true` permanently deletes the messages it returns
 * (see the `act` tier note in `mcp-tool-tiers.ts`) and `relay_register_endpoint`
 * creates a mailbox.
 *
 * The exemption is deliberate. An agent polls its inbox continuously, so a card
 * per poll would train the user to dismiss cards without reading them, which
 * weakens every other approval card. What bounds the damage instead is that the
 * server injects the caller's identity and the endpoint tools refuse any inbox
 * the caller does not own, so an `ack` can only ever destroy the caller's own
 * mail. Cross-agent messaging authorization lives in relay/access-rules.json.
 *
 * ## Why this is a hand-written list and not derived (DOR-499)
 *
 * This is the fourth place DorkOS names a subset of its MCP tools, and the most
 * consequential: everything here is auto-allowed in `canUseTool` without ever
 * asking a person. DOR-499 collapsed three OTHER such lists into
 * `@dorkos/shared/mcp-tool-groups` and deliberately left this one alone, for the
 * same reason the tokenless read-only carve-out in
 * `core/external-mcp/tool-security.ts` was left alone.
 *
 * It is not the same predicate as any group or tier. A group answers "which toggle
 * takes this away". A tier answers "does this need approval in general". This list
 * answers the narrower question above: does this tool carry its own authorization,
 * so that a card would add friction without adding safety? That is a hand-picked
 * judgment, not a property of the tier. `relay_register_endpoint` and
 * `mesh_register` are `act` and are here; plenty of other `act` tools are
 * deliberately not. Deriving the list from `act` + `observe` would auto-admit every
 * future `act` tool to a no-prompt path as a side effect of picking a tier, and
 * that is fail-open on the one axis where it costs something real.
 *
 * So it stays hand-written, and the relationship is pinned in the safe direction
 * instead: `core/__tests__/mcp-tool-gate.test.ts` asserts every name here is a real
 * tool and that none is `destructive`. That catches a rename going stale and a
 * dangerous addition, without letting the tier table grant anything.
 *
 * ## Membership is necessary, not sufficient (DOR-625)
 *
 * A name here means "do not ask ABOUT THE TOOL". It does not mean every call to
 * that tool is auto-allowed, and for one member it must not: `control_ui` is a
 * multiplexer carrying 22 different effects behind one name, and one of them
 * (`apply_layout`) reaches a mutating DorkOS route. {@link isAutoAllowedCall}
 * makes the final decision per CALL, so a tool on this list can still be
 * per-argument gated. Read the two together — this set alone no longer answers
 * the question.
 */
export const DORKOS_AGENT_TOOLS = new Set([
  'mcp__dorkos__relay_send',
  'mcp__dorkos__relay_inbox',
  'mcp__dorkos__relay_list_endpoints',
  'mcp__dorkos__relay_register_endpoint',
  'mcp__dorkos__mesh_list',
  'mcp__dorkos__mesh_inspect',
  'mcp__dorkos__mesh_discover',
  'mcp__dorkos__mesh_register',
  'mcp__dorkos__mesh_status',
  'mcp__dorkos__mesh_query_topology',
  'mcp__dorkos__get_agent',
  // UI control tools. `get_ui_state` only reads. `control_ui` is the multiplexer
  // — most of its actions only move pixels, but not all of them, so its calls go
  // through `isAutoAllowedCall` below rather than riding this membership alone.
  'mcp__dorkos__control_ui',
  'mcp__dorkos__get_ui_state',
]);

/** The multiplexer on {@link DORKOS_AGENT_TOOLS}: one name, 22 different effects. */
const CONTROL_UI_TOOL = 'mcp__dorkos__control_ui';

/**
 * Whether one CALL to a safe-listed tool may skip the approval card, given its
 * arguments (DOR-625).
 *
 * Every safe-listed tool answers `true` except `control_ui`, whose verdict is
 * per-action: {@link UI_COMMAND_REACH} classifies each of the 22 UI commands, and
 * only the `client-only` ones skip. The classification is a total `Record` over
 * the command union, so a new UI command cannot be added without `tsc` demanding
 * a verdict for it.
 *
 * **Fails closed twice.** An input the command union rejects has no known action,
 * so there is nothing to look up and the call asks — "no rule" is never consent.
 * And a call that is not auto-allowed is not denied here either: it falls through
 * to {@link resolveModeDecision}, which raises a card in every mode but
 * `bypassPermissions`.
 *
 * @param toolName - The tool the model called.
 * @param input - The raw arguments it called with.
 * @returns `true` to skip the card, `false` to hand the call to the mode table.
 */
function isAutoAllowedCall(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== CONTROL_UI_TOOL) return true;
  const parsed = UiCommandSchema.safeParse(input);
  if (!parsed.success) return false;
  return UI_COMMAND_REACH[parsed.data.action] === 'client-only';
}

// ---------------------------------------------------------------------------
// Permission-mode decision table
// ---------------------------------------------------------------------------

/** What a permission mode says to do with a tool call the safe-lists did not cover. */
export type ModeDecision = 'allow' | 'ask';

/**
 * Decide what a session's permission mode does with one tool call.
 *
 * This is the gate's closed end: an **exhaustive** switch over
 * {@link PermissionMode} where every arm names its mode. Adding a member to the
 * union without deciding here is a `tsc` error, not a silent auto-allow — the
 * `never` assignment in the `default` arm enforces that, and it is the whole
 * point of the function.
 *
 * ## Why everything but `bypassPermissions` asks
 *
 * `canUseTool` is not the first gate — it is the last one. The Claude Code CLI
 * runs its own permission engine first and only round-trips to this callback for
 * calls it has **already decided need asking** (`--permission-prompt-tool stdio`;
 * its `createCanUseTool` returns straight away on `allow`/`deny` and sends a
 * `can_use_tool` control request only on `ask`). Verified against the shipped
 * binary at SDK 0.3.177 / CLI 2.1.177:
 *
 * - Under `acceptEdits` the CLI auto-allows a write **inside** the allowed
 *   working directories on its own. An edit that reaches DorkOS is one the CLI
 *   escalated on purpose — `decisionReason: {type:'workingDir', reason:'Path is
 *   outside allowed working directories'}`. Auto-accepting it here would
 *   rubber-stamp exactly that escalation, which is how `~/.ssh/authorized_keys`
 *   or `~/.zshrc` gets written by an agent that was told to stay in a project.
 * - Under `acceptEdits` the CLI also auto-allows a 7-command filesystem
 *   allowlist (`mkdir touch rm rmdir mv cp sed`) and any read-only command.
 *   Every other shell command — `curl … | sh`, `npm install`, `python x.py` —
 *   falls through to `ask` and lands here. Returning `allow` for those is what
 *   let a Slack message run a shell command on the operator's machine (DOR-604).
 *
 * So the honest rule is: if a call got this far, someone should look at it. The
 * shipped description "Auto-accept file edits; still prompt for other tools"
 * stays true end-to-end — the auto-accepting happens one layer up, where it can
 * still tell an in-workspace edit from an escape.
 *
 * The two bullets above are **still dated to SDK 0.3.177 / CLI 2.1.177 and were
 * NOT re-verified** on the 0.3.224 bump — nobody re-read the CLI's permission
 * engine for the `acceptEdits` working-directory escalation or the 7-command
 * allowlist. Note that this function's own conclusion does not rest on them: it
 * asks for everything but `bypassPermissions`, so a CLI that escalated MORE than
 * these bullets describe is still handled correctly. They would only become wrong
 * in the direction that matters if the CLI started escalating LESS.
 *
 * `bypassPermissions` is the sole exception, because it means "skip all tool
 * approval prompts". Note this is a policy choice, not an unreachable branch:
 * the CLI resolves most calls itself under that mode, but it still escalates a
 * few — a dangerous `rm`/`rmdir`, for one — and those do arrive here, where this
 * function allows them. That is the same "the CLI escalated on purpose and we
 * rubber-stamped it" shape fixed above for `acceptEdits`, and it is deliberate
 * only because the mode is named for it. Tracked separately.
 *
 * @param mode - The session's permission mode.
 * @returns `'allow'` to run without asking, `'ask'` to raise an approval card.
 */
export function resolveModeDecision(mode: PermissionMode): ModeDecision {
  switch (mode) {
    // "Skip all tool approval prompts" — this mode IS consent. The CLI resolves
    // most calls under it upstream, but not quite all (see the TSDoc above).
    case 'bypassPermissions':
      return 'allow';

    // Every remaining mode asks, each for its own reason:
    //   `default`     — "Prompt on tool use", exactly as shipped.
    //   `acceptEdits` — the CLI already auto-accepted in-workspace writes; what
    //                   reaches here left the working directory.
    //   `auto`        — research-preview classifier; DorkOS still raises a card.
    //   `plan`        — read-only planning; the CLI answers writes with "Cannot
    //                   write to X while in plan mode". Nothing executes here.
    //   `dontAsk`     — not surfaced by DorkOS and denied upstream by the CLI,
    //                   so this is unreachable; `ask` is the safe answer anyway.
    case 'default':
    case 'acceptEdits':
    case 'auto':
    case 'plan':
    case 'dontAsk':
      return 'ask';

    default: {
      // Unreachable while the switch is exhaustive; if a new mode is added to
      // `PermissionMode` this line stops compiling. At runtime an unknown mode
      // asks — absence of a rule is never consent.
      const exhaustive: never = mode;
      void exhaustive;
      return 'ask';
    }
  }
}

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
   * Optional because the handlers below work perfectly well without it and a
   * test fake should not have to invent one — but a real `AgentSession` always
   * carries it, so the one line that matters
   * ({@link logInteractionTimeout}) can name the session a person has to open.
   */
  sdkSessionId?: string;
}

/**
 * Say that nobody answered, so this was denied.
 *
 * **The only DURABLE trace an expired prompt leaves.** All three handlers
 * below hand the model a denial after {@link SESSIONS.INTERACTION_TIMEOUT_MS}
 * and, until DOR-1158, wrote nothing anywhere: the card vanished from any
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
 */
function logInteractionTimeout(
  session: InteractiveSession,
  interaction: { id: string; kind: 'approval' | 'question' | 'elicitation'; toolName?: string }
): void {
  logRefusal('[claude-code] nobody answered in time, so this was denied', {
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
      waitedMs: SESSIONS.INTERACTION_TIMEOUT_MS,
    },
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
function notifyInteractionCancelled(
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

/** The operator-facing notice for an AskUserQuestion that timed out unanswered. */
function questionTimeoutNotice(questions: QuestionItem[]): string {
  const base = `I asked you something and waited ${INTERACTION_TIMEOUT_MINUTES} minutes with no answer, so I moved on.`;
  const first = questions[0]?.question;
  return first ? `${base} The question was: "${truncateForNotice(first, 120)}"` : base;
}

/**
 * The label to name a tool by in operator-facing prose: the SDK's own
 * `displayName` when it gave a non-blank one, else the raw tool name. Guards
 * against an empty-string `displayName` producing "I asked to run  and
 * waited…" — `??` alone only catches `undefined`, not `""`.
 */
function toolLabelFor(displayName: string | undefined, toolName: string): string {
  return displayName?.trim() ? displayName : toolName;
}

/** The operator-facing notice for a tool approval that timed out unanswered. */
function approvalTimeoutNotice(toolLabel: string): string {
  return `I asked to run ${toolLabel} and waited ${INTERACTION_TIMEOUT_MINUTES} minutes with no answer, so I treated it as declined.`;
}

/** The operator-facing notice for an MCP elicitation that timed out unanswered. */
function elicitationTimeoutNotice(serverName: string): string {
  return `${serverName} asked you something and I waited ${INTERACTION_TIMEOUT_MINUTES} minutes with no answer, so I declined on your behalf.`;
}

/**
 * Handle an AskUserQuestion tool call — pause, collect answers, inject into input.
 *
 * `signal` is the SDK's per-tool-call abort signal: a mid-turn steered message
 * (or an interrupt) cancels the pending question SDK-side, so without the
 * abort listener the pending record lingered as an answerable ghost card for
 * the full 10-minute expiry (acceptance run 20260610-173202, F5 — this handler
 * was the one interactive path with NO abort wiring).
 */
export function handleAskUserQuestion(
  session: InteractiveSession,
  toolUseId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<PermissionResult> {
  const questions = input.questions as QuestionItem[];
  const startedAt = Date.now();
  session.eventQueue.push({
    type: 'question_prompt',
    data: {
      toolCallId: toolUseId,
      questions,
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      session.pendingInteractions.delete(toolUseId);
      notifyInteractionCancelled(session, toolUseId, 'aborted');
      resolve({ behavior: 'deny', message: 'Question cancelled' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      session.pendingInteractions.delete(toolUseId);
      logInteractionTimeout(session, { id: toolUseId, kind: 'question' });
      notifyInteractionCancelled(session, toolUseId, 'timeout');
      notifyInteractionTimeoutNotice(session, questionTimeoutNotice(questions));
      resolve({ behavior: 'deny', message: 'User did not respond within 10 minutes' });
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'question',
      toolCallId: toolUseId,
      startedAt,
      snapshot: { questions },
      resolve: (answers) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(toolUseId);
        // Translate DorkOS's canonical (index-keyed) answers into the SDK's
        // question-text-keyed format. Without this the native AskUserQuestion
        // executor finds no matching answers and tells the model the user did
        // not respond. See sessions/question-answers.ts.
        resolve({
          behavior: 'allow',
          updatedInput: { ...input, answers: toSdkQuestionAnswers(answers, questions) },
        });
      },
      reject: () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'deny', message: 'Interaction cancelled' });
      },
      timeout,
    });
  });
}

/**
 * Handle an MCP elicitation request — pause, collect user input, return result.
 *
 * The `onElicitation` SDK callback receives the request from an MCP server
 * and must return an ElicitationResult. We push an SSE event to the client,
 * wait for the user's response, and resolve the Promise.
 */
export function handleElicitation(
  session: InteractiveSession,
  request: ElicitationRequest,
  signal: AbortSignal
): Promise<ElicitationResult> {
  const interactionId = request.elicitationId ?? randomUUID();
  const startedAt = Date.now();

  session.eventQueue.push({
    type: 'elicitation_prompt',
    data: {
      interactionId,
      serverName: request.serverName,
      message: request.message,
      mode: request.mode,
      url: request.url,
      elicitationId: request.elicitationId,
      requestedSchema: request.requestedSchema,
      timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
    },
  });
  session.eventQueueNotify?.();

  return new Promise<ElicitationResult>((resolve) => {
    const decline = () => resolve({ action: 'decline' } as ElicitationResult);

    // Auto-decline if the SDK query is aborted
    const onAbort = () => {
      clearTimeout(timeout);
      session.pendingInteractions.delete(interactionId);
      notifyInteractionCancelled(session, interactionId, 'aborted');
      decline();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      session.pendingInteractions.delete(interactionId);
      logInteractionTimeout(session, { id: interactionId, kind: 'elicitation' });
      notifyInteractionCancelled(session, interactionId, 'timeout');
      notifyInteractionTimeoutNotice(session, elicitationTimeoutNotice(request.serverName));
      decline();
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(interactionId, {
      type: 'elicitation',
      toolCallId: interactionId,
      startedAt,
      snapshot: {
        serverName: request.serverName,
        message: request.message,
        mode: request.mode,
        url: request.url,
        elicitationId: request.elicitationId,
        requestedSchema: request.requestedSchema,
      },
      resolve: (result) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(interactionId);
        resolve(result as ElicitationResult);
      },
      reject: () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(interactionId);
        decline();
      },
      timeout,
    });
  });
}

/**
 * The two log levels the tool gate needs.
 *
 * Routine verdicts (auto-allow, routing) are `debug` — they fire for every tool
 * call and would drown a production log. Raising an approval card is `info`
 * (DOR-782): it is the moment a turn stops making progress and starts waiting
 * for a person, and diagnosing a turn that "hung" is exactly when someone reads
 * the log at the default level.
 */
export interface ToolGateLogger {
  debug(message: string, data: Record<string, unknown>): void;
  info(message: string, data: Record<string, unknown>): void;
}

/** SDK context fields forwarded with tool approval requests. */
export interface ToolApprovalContext {
  signal: AbortSignal;
  toolUseID: string;
  /**
   * The subagent this call came from, when it came from one (SDK 0.3.177,
   * `CanUseTool`'s `agentID`; `agent_id` on the wire). Absent on the main thread.
   *
   * Its presence is the standing evidence that a subagent's tool calls DO reach
   * this gate: for foreground `Task` subagents the CLI routes them to the same
   * `can_use_tool` callback, so they raise a normal approval card and pause the
   * stall watchdog like any other. That much is pinned by a test.
   *
   * What BACKGROUNDED (async) subagents do is an open question, deliberately not
   * asserted here (DOR-795). `SDKControlPermissionRequest` lists `asyncAgent`
   * among its `decision_reason_type` values, which suggests those asks are
   * escalated to this callback too rather than resolved upstream — but the
   * deciding logic lives in the native CLI binary, not in the shipped JS, so it
   * cannot be read from here and has not been observed live. Do not build on
   * either answer without checking.
   */
  agentID?: string;
  title?: string;
  displayName?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
  suggestions?: PermissionUpdate[];
}

/**
 * Create the `canUseTool` callback for an SDK query.
 *
 * Routes `AskUserQuestion` to the question handler, auto-allows calls to the two
 * safe-listed tool sets ({@link READ_ONLY_TOOLS}, {@link DORKOS_AGENT_TOOLS})
 * that {@link isAutoAllowedCall} also clears, and hands every remaining call to
 * {@link resolveModeDecision}, which either allows it or raises an approval card.
 *
 * Nothing reaches a person's machine on a fall-through: a tool that matches no
 * safe list and no permissive mode asks. `Bash` under `acceptEdits` asks.
 *
 * @param session - The interactive session state (with its permission mode).
 * @param log - Where the gate reports its verdicts; see {@link ToolGateLogger}.
 * @param onToolPreflight - Optional hook fired for EVERY tool BEFORE it runs and
 *   before any approval wait — the synchronous pre-tool seam DorkOS uses to
 *   snapshot a file's pre-edit bytes for the diff base (DOR-212). Awaited so the
 *   snapshot is guaranteed captured before the SDK applies the edit; a rejection
 *   is swallowed by the caller's wiring so capture never blocks a tool.
 */
export function createCanUseTool(
  session: InteractiveSession & { permissionMode: PermissionMode },
  log: ToolGateLogger,
  onToolPreflight?: (toolName: string, input: Record<string, unknown>) => Promise<void>
): (
  toolName: string,
  input: Record<string, unknown>,
  context: ToolApprovalContext
) => Promise<PermissionResult> {
  return async (toolName, input, context) => {
    if (onToolPreflight) await onToolPreflight(toolName, input);
    if (toolName === 'AskUserQuestion') {
      log.debug('[canUseTool] routing to question handler', {
        toolName,
        toolUseID: context.toolUseID,
      });
      return handleAskUserQuestion(session, context.toolUseID, input, context.signal);
    }

    // Safe-list membership is necessary but not sufficient: `isAutoAllowedCall`
    // has the last word, so a multiplexer tool can still be gated per argument
    // (DOR-625). A refused call is not denied — it falls through to the mode
    // table below, which raises a card.
    if (
      (READ_ONLY_TOOLS.has(toolName) || DORKOS_AGENT_TOOLS.has(toolName)) &&
      isAutoAllowedCall(toolName, input)
    ) {
      log.debug('[canUseTool] auto-allow safe tool', { toolName, toolUseID: context.toolUseID });
      return { behavior: 'allow', updatedInput: input };
    }

    if (resolveModeDecision(session.permissionMode) === 'ask') {
      // info, not debug: from here the turn makes no progress until a person
      // answers, and this line is what tells a reader that (DOR-782).
      // `agentID` is present when the call came from inside a subagent, which is
      // the case that is hardest to explain from the outside.
      log.info('[canUseTool] requesting approval', {
        toolName,
        permissionMode: session.permissionMode,
        toolUseID: context.toolUseID,
        ...(context.agentID !== undefined ? { agentID: context.agentID } : {}),
      });
      return handleToolApproval(session, context.toolUseID, toolName, input, context);
    }
    log.debug('[canUseTool] auto-allow', {
      toolName,
      permissionMode: session.permissionMode,
      toolUseID: context.toolUseID,
    });
    return { behavior: 'allow', updatedInput: input };
  };
}

/**
 * What the model is told when a person refuses a tool call.
 *
 * The reason is the whole point of carrying one: told only "denied", an agent
 * typically retries the same call or stalls; told why, it can take another
 * route. A blank reason is treated as no reason — the transcript receipt claims
 * the agent was told why only when something was actually delivered, so an
 * empty string must not quietly become a claim.
 *
 * @param reason - The person's own words, when they gave any.
 */
function denialMessage(reason?: string): string {
  const said = reason?.trim();
  return said ? `User denied tool execution. Reason: ${said}` : 'User denied tool execution';
}

/**
 * Handle tool approval — pause and wait for a person.
 *
 * Reached for every mode except `bypassPermissions` (see
 * {@link resolveModeDecision}), not just `'default'` as this once said.
 *
 * Pushes an `approval_required` SSE event to the client, registers a pending
 * interaction, and waits for the user's response (approve, always-allow, or deny).
 * Auto-denies on timeout or if the SDK query is aborted.
 */
export function handleToolApproval(
  session: InteractiveSession,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  context: ToolApprovalContext
): Promise<PermissionResult> {
  const startedAt = Date.now();
  const timeoutMinutes = Math.ceil(SESSIONS.INTERACTION_TIMEOUT_MS / 60_000);

  session.eventQueue.push({
    type: 'approval_required',
    data: {
      toolCallId: toolUseId,
      toolName,
      input: JSON.stringify(input),
      timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
      startedAt,
      // SDK-provided rich context for the approval UI
      title: context.title,
      displayName: context.displayName,
      description: context.description,
      blockedPath: context.blockedPath,
      decisionReason: context.decisionReason,
      hasSuggestions: (context.suggestions?.length ?? 0) > 0,
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve) => {
    const deny = (message: string) => resolve({ behavior: 'deny', message });

    // Auto-deny if the SDK query is aborted (e.g. user interrupts the stream)
    const onAbort = () => {
      clearTimeout(timeout);
      session.pendingInteractions.delete(toolUseId);
      notifyInteractionCancelled(session, toolUseId, 'aborted');
      deny('Tool approval aborted');
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      context.signal.removeEventListener('abort', onAbort);
      session.pendingInteractions.delete(toolUseId);
      logInteractionTimeout(session, { id: toolUseId, kind: 'approval', toolName });
      notifyInteractionCancelled(session, toolUseId, 'timeout');
      notifyInteractionTimeoutNotice(
        session,
        approvalTimeoutNotice(toolLabelFor(context.displayName, toolName))
      );
      deny(`Tool approval timed out after ${timeoutMinutes} minutes`);
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'approval',
      toolCallId: toolUseId,
      suggestions: context.suggestions,
      startedAt,
      snapshot: {
        toolName,
        input: JSON.stringify(input),
        title: context.title,
        displayName: context.displayName,
        description: context.description,
        blockedPath: context.blockedPath,
        decisionReason: context.decisionReason,
        hasSuggestions: (context.suggestions?.length ?? 0) > 0,
      },
      resolve: (result, denyReason) => {
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(toolUseId);

        if (Array.isArray(result)) {
          // "Always Allow" — forward SDK permission suggestions
          resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: result });
        } else if (result) {
          resolve({ behavior: 'allow', updatedInput: input });
        } else {
          deny(denialMessage(denyReason));
        }
      },
      reject: () => {
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(toolUseId);
        deny('Interaction cancelled');
      },
      timeout,
    });
  });
}
