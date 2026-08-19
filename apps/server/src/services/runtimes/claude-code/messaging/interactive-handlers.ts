import type {
  PermissionResult,
  PermissionUpdate,
  ElicitationRequest,
  ElicitationResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, QuestionItem } from '@dorkos/shared/types';
import { UI_COMMAND_REACH, UiCommandSchema } from '@dorkos/shared/schemas';
import type { PermissionMode } from '@dorkos/shared/schemas';
import { createInSessionContextResolver } from '../../../core/agent-identity/index.js';
import { logRefusal } from '../../../observability/refusals.js';
import { logger } from '../../../../lib/logger.js';
import { SESSIONS } from '../../../../config/constants.js';
import { toSdkQuestionAnswers } from '../sessions/question-answers.js';
import { inSessionToolName } from '../mcp-tools/tool-exposure.js';
import {
  approvalTimeoutDenial,
  describeWaited,
  questionTimeoutDenial,
  toolDenial,
  WITHDRAWN_DENIALS,
} from '../sessions/tool-result-outcome.js';
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
 * So the MEMBERSHIP stays hand-written, and the relationship is pinned in the safe
 * direction instead: `core/__tests__/mcp-tool-gate.test.ts` asserts every name here is
 * a real tool and that none is `destructive`. That catches a rename going stale and a
 * dangerous addition, without letting the tier table grant anything.
 *
 * The QUALIFIED SPELLING is not hand-written, though, and that distinction matters
 * (DOR-1292). These names are matched against what the SDK sends, which is
 * `mcp__<server>__<tool>` — so they used to be typed out with the prefix baked in,
 * in three separate places. Renaming the MCP server would then have silently
 * emptied this set: not a crash, just every DorkOS tool raising an approval card
 * from that moment on, the room verbs included, whose entire purpose is to avoid a
 * card nobody is positioned to answer. Deriving the prefix from
 * {@link inSessionToolName} makes that impossible, and `tool-exposure.test.ts` pins
 * that every entry here starts with it.
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
export const DORKOS_AGENT_TOOLS = new Set(
  [
    // The `rooms` domain, plus the one relay verb that reaches a PERSON. Every one
    // of these is auto-allowed only for a session that HAS an agent identity — see
    // {@link IDENTITY_SCOPED_TOOLS}, which is where the whole argument for them
    // lives.
    'post_to_room',
    'react_to_room_entry',
    'read_room_history',
    'search_room_history',
    'relay_notify_user',
    'relay_send',
    'relay_inbox',
    'relay_list_endpoints',
    'relay_register_endpoint',
    'mesh_list',
    'mesh_inspect',
    'mesh_discover',
    'mesh_register',
    'mesh_status',
    'mesh_query_topology',
    'get_agent',
    // UI control tools. `get_ui_state` only reads. `control_ui` is the multiplexer
    // — most of its actions only move pixels, but not all of them, so its calls go
    // through `isAutoAllowedCall` below rather than riding this membership alone.
    'control_ui',
    'get_ui_state',
  ].map(inSessionToolName)
);

/**
 * The members of {@link DORKOS_AGENT_TOOLS} whose auto-allow holds only while
 * the SESSION HAS AN AGENT IDENTITY (DOR-1229, extended by DOR-1265).
 *
 * What they have in common is the reason they may skip a card at all: **an
 * identified agent's reach here is bounded to a scope the OWNER already set up**
 * — the rooms she seated it in, and the chats her bindings already let it speak
 * first in. The identity is what makes that sentence true, which is why losing
 * it takes the auto-allow with it. It is a bound on the SCOPE, not a promise
 * about the audience: see the notify section below for how wide the operator can
 * (and by default does) set that scope.
 *
 * What the auto-allow gives up is stated once, here, because it is the same
 * thing for all five: **the per-call card an operator watching a DIRECT session
 * could have denied.** Not the setup consent, which is untouched — a room the
 * agent is not a member of, and a binding nobody switched initiating on for, are
 * both still refused underneath. (Note what that does NOT say: an unclaimed CHAT
 * is not necessarily refused, because a wildcard binding's scope covers the whole
 * adapter. The consent that holds is the one on the binding, not one per chat.)
 *
 * ## Why the four rooms verbs need the qualifier
 *
 * The rooms verbs authorize on MEMBERSHIP: each resolves the caller's roster row
 * before doing anything, and the two reads answer "not a member" with the same
 * `ROOM_NOT_FOUND` they answer "no such room" with, so a room id is not a
 * capability and a probe learns nothing.
 *
 * **That bound only exists for an AGENT caller**, which is the whole reason this
 * set is separate. Who the caller IS comes from `callerAuthor`
 * (`services/rooms/room-capabilities.ts`): with no identity in the invocation
 * context and no login on this install, it falls back to the person who OWNS the
 * install. The owner is exempt from the membership check by design —
 * `seesEveryRoom` short-circuits `canSee`, so every room on the machine is
 * readable, the owner's own DMs with agents included — and an owner-attributed
 * post lands as a human message at cascade depth zero, which triggers every
 * always/mentioned agent in the channel and is bounded by no claim. So without
 * the qualifier these four would have been a no-prompt path to the operator's
 * whole room history from any ordinary coding session.
 *
 * ## Why `relay_notify_user` is here too (DOR-1265)
 *
 * It is not a rooms verb and it authorizes on nothing like membership — it is
 * here because a note can only land inside a SCOPE THE OPERATOR SET. Two earlier
 * drafts of this comment got the scope wrong in the narrow direction, so it is
 * spelled out:
 *
 * - **Their own DorkOS DM** — the 1:1 they share with this agent, used when no
 *   external chat can carry the note (`relay/notify-dm.ts`, DOR-1209).
 * - **Whatever their bindings already permit this agent to START a conversation
 *   in.** Two operator acts gate that: a binding has to exist, and its "Agent
 *   can start conversations" switch has to be on (`canInitiate`, per binding,
 *   default FALSE). What the scope then COVERS is the operator's choice too, and
 *   it is often wider than one chat: a binding may name a group, a chat with
 *   somebody else, or — with the chat filter left empty, which is the cockpit's
 *   default for a new binding ("Any chat (wildcard)") — **every chat that has
 *   messaged that adapter, including ones nobody claimed**. That is stated
 *   exactly this way in `relay/initiate-consent.ts`: sender scoping does not
 *   narrow a wildcard binding, "because that is the scope the person chose when
 *   they left the chat filter empty".
 *
 * So: a note is NOT necessarily private to the operator, and not necessarily to
 * somebody they hand-picked. It is always inside a scope they configured and
 * switched on. The tool's `channel` argument selects among those bindings; it
 * cannot create one, widen one, or get past `canInitiate`
 * (`resolveNotifyTarget` → `bindingAllowsInitiate`, answered `INITIATE_NOT_ALLOWED`).
 *
 * So what a card here was actually asking was "may this agent use the channel
 * you already gave it, this once" — a fair question in a session somebody is
 * watching, and an unanswerable one in a room turn. Measured live on 2026-08-16:
 * asked in a channel to send a proactive note, the agent's room turn parked on
 * `awaiting_approval` and no message was ever sent, twice on two days.
 *
 * What bounds the frequency instead is a mechanism, per
 * `.claude/rules/room-conduct.md`: `NotifyBudget` (`relay/notify-budget.ts`),
 * ten notes per agent per hour, with a refusal that tells the agent to say it in
 * the conversation it is already in.
 *
 * Without an identity the tool refuses itself — the handler answers
 * `NOT_AN_AGENT` — so the qualifier costs a call nothing today. It is still
 * stated rather than assumed: the gate must not be the layer that decides a call
 * is harmless because some other layer happens to refuse it. (And the two do not
 * resolve identity through the same store — see below.)
 *
 * ## Where identity comes from
 *
 * One KEY — the session's working directory — resolved here by
 * {@link createInSessionContextResolver}, the same function, with the same
 * argument, that `mcp-tools/index.ts` builds the capability resolver from. For
 * the rooms verbs that is also the same STORE, so this gate and the caller those
 * four run as cannot disagree.
 *
 * **`relay_notify_user` is the exception, and not one to paper over.** The gate's
 * answer comes from an unrevoked `agent_identity_tokens` row
 * (`AgentIdentityService.describeAgent`); the tool's sender comes from the MESH
 * registry (`resolveSenderIdentity` → `meshCore.getSubjectByPath`), which it has
 * to, because the relay `from` is an authorization principal that ACL rules match
 * on and only the mesh knows an agent's canonical subject. Two stores, one key.
 * Where they disagree the GATE is the permissive one, so the outcome is a turn
 * that proceeds and gets a structured `NOT_AN_AGENT` back — no card, no note, and
 * a different failure from the one this fix was about. Both directions are pinned
 * in `core/__tests__/mcp-relay-notify-tools.test.ts`.
 *
 * A room turn is handed the addressed agent's own directory
 * (`room-turn-runner.ts`), and an agent a room dispatched to is in the mesh by
 * construction, so the two agree wherever this was meant to work: the verbs are
 * frictionless there. An ordinary cockpit session in a plain project directory
 * resolves neither, and keeps today's card.
 *
 * ## Why they are auto-allowed at all, once identity holds
 *
 * A room triggers a turn INTO THE DARK — nobody is holding that session's
 * stream — under the runtime's strictest permission mode, so a card raised
 * there is a card nobody is positioned to answer. Measured on 2026-08-16:
 * `search_room_history` asked at 15s, the room said the agent was waiting at
 * 75s, and the turn made no further progress until the interaction window
 * auto-denied it ten minutes later. Eleven minutes to answer one question.
 *
 * It is also what the rooms domain already asks for: "A card on every message
 * an agent posts into its own room would be the over-tiering that teaches
 * people to click through", with the writes bounded by mechanisms instead — the
 * cascade guard and the two-ceiling turn budget for a post, the hourly
 * `ReactionBudget` for a reaction, the hourly `NotifyBudget` for a note. This
 * list was the one place not told.
 */
export const IDENTITY_SCOPED_TOOLS = new Set(
  [
    'post_to_room',
    'react_to_room_entry',
    'read_room_history',
    'search_room_history',
    'relay_notify_user',
  ].map(inSessionToolName)
);

/** The multiplexer on {@link DORKOS_AGENT_TOOLS}: one name, 22 different effects. */
const CONTROL_UI_TOOL = inSessionToolName('control_ui');

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
  /**
   * The session's working directory — the ONLY thing the in-session surface
   * resolves an agent identity from, and therefore what decides who the
   * owner-facing verbs act as ({@link IDENTITY_SCOPED_TOOLS}).
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
 * **The only DURABLE trace an expired prompt leaves.** All three handlers
 * below hand the model a denial once the wait runs out — four hours for a
 * session somebody could come back to, ten minutes for an unattended run —
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
 * @param interaction.kind - Which of the three kinds of prompt parked.
 * @param interaction.toolName - The tool an approval was about, when there is one.
 */
function logInteractionParked(
  session: InteractiveSession,
  interaction: { kind: 'approval' | 'question' | 'elicitation'; toolName?: string }
): void {
  logger.info('[claude-code] nobody answered in time, so the agent is waiting', {
    kind: interaction.kind,
    toolName: interaction.toolName,
    ...(session.sdkSessionId !== undefined ? { sessionId: session.sdkSessionId } : {}),
    waitsUntilMs: SESSIONS.INTERACTION_PARK_CEILING_MS,
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

/** The operator-facing notice for an AskUserQuestion nobody has answered yet. */
function questionParkedNotice(questions: QuestionItem[]): string {
  const base = `I asked you something ${INTERACTION_TIMEOUT_MINUTES} minutes ago and nobody has answered, so I am waiting here.`;
  const first = questions[0]?.question;
  return first ? `${base} The question was: "${truncateForNotice(first, 120)}"` : base;
}

/**
 * The operator-facing notice for an AskUserQuestion nobody ever answered.
 *
 * @param waited - How long the agent waited, in words.
 */
function questionTimeoutNotice(waited: string): string {
  return `I waited ${waited} for an answer and nobody came, so I moved on.`;
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

/** The operator-facing notice for a tool approval nobody has answered yet. */
function approvalParkedNotice(toolLabel: string): string {
  return `I asked to run ${toolLabel} and nobody has answered yet, so I am waiting here until somebody does.`;
}

/**
 * The operator-facing notice for a tool approval nobody ever answered.
 *
 * @param toolLabel - What the tool is called, in the agent's own prose.
 * @param waited - How long the agent waited, in words.
 */
function approvalTimeoutNotice(toolLabel: string, waited: string): string {
  return `I waited ${waited} for an answer about ${toolLabel} and nobody came, so I treated it as declined.`;
}

/** The operator-facing notice for an MCP elicitation nobody has answered yet. */
function elicitationParkedNotice(serverName: string): string {
  return `${serverName} asked you something and nobody has answered yet, so I am waiting here until somebody does.`;
}

/**
 * The operator-facing notice for an MCP elicitation nobody ever answered.
 *
 * @param serverName - The MCP server that asked.
 * @param waited - How long the agent waited, in words.
 */
function elicitationTimeoutNotice(serverName: string, waited: string): string {
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
 * @param session - The session holding the prompt.
 */
function refusalDeadlineMs(session: InteractiveSession): number {
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
function armInteractionWait(
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
    logInteractionParked(session, log);
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
function clearInteractionTimer(session: InteractiveSession, interactionId: string): void {
  const entry = session.pendingInteractions.get(interactionId);
  if (entry !== undefined) clearTimeout(entry.timeout);
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
      clearInteractionTimer(session, toolUseId);
      session.pendingInteractions.delete(toolUseId);
      notifyInteractionCancelled(session, toolUseId, 'aborted');
      resolve({ behavior: 'deny', message: WITHDRAWN_DENIALS.question });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const waitedMs = refusalDeadlineMs(session);
    const timeout = armInteractionWait(
      session,
      toolUseId,
      {
        parked: questionParkedNotice(questions),
        expired: questionTimeoutNotice(describeWaited(waitedMs)),
      },
      { kind: 'question' },
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve({ behavior: 'deny', message: questionTimeoutDenial(waitedMs) });
      }
    );

    session.pendingInteractions.set(toolUseId, {
      type: 'question',
      toolCallId: toolUseId,
      startedAt,
      snapshot: { questions },
      resolve: (answers) => {
        clearInteractionTimer(session, toolUseId);
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
        clearInteractionTimer(session, toolUseId);
        signal?.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'deny', message: WITHDRAWN_DENIALS.interaction });
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
      clearInteractionTimer(session, interactionId);
      session.pendingInteractions.delete(interactionId);
      notifyInteractionCancelled(session, interactionId, 'aborted');
      decline();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const timeout = armInteractionWait(
      session,
      interactionId,
      {
        parked: elicitationParkedNotice(request.serverName),
        expired: elicitationTimeoutNotice(
          request.serverName,
          describeWaited(refusalDeadlineMs(session))
        ),
      },
      { kind: 'elicitation' },
      () => {
        signal.removeEventListener('abort', onAbort);
        decline();
      }
    );

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
        clearInteractionTimer(session, interactionId);
        signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(interactionId);
        resolve(result as ElicitationResult);
      },
      reject: () => {
        clearInteractionTimer(session, interactionId);
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
 * Whether this session resolves to an agent identity, for the owner-facing gate
 * ({@link IDENTITY_SCOPED_TOOLS}).
 *
 * **Fails CLOSED, and that is the whole point of not inlining it.** The resolver
 * reads the agent index off disk, and a throw there must mean "ask", never "skip
 * the card". What is on the other side differs per verb — for the four rooms
 * verbs an unresolved caller becomes the person who OWNS the install, who sees
 * every room on the machine; for `relay_notify_user` it is a message to a person
 * sent by a session nobody can name — and neither is something to wave through
 * because a disk read failed. `createInSessionContextResolver` already swallows
 * its own errors, so this catch is the belt to that braces: a future resolver
 * that throws cannot silently widen the auto-allow.
 *
 * @param resolveIdentity - The memoized session-identity resolver.
 * @param log - Where a failed lookup is reported.
 */
async function hasAgentIdentity(
  resolveIdentity: () => Promise<unknown>,
  log: ToolGateLogger
): Promise<boolean> {
  try {
    return (await resolveIdentity()) !== undefined;
  } catch (err) {
    log.info('[canUseTool] could not resolve this session identity; asking instead', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Create the `canUseTool` callback for an SDK query.
 *
 * Routes `AskUserQuestion` to the question handler, auto-allows calls to the two
 * safe-listed tool sets ({@link READ_ONLY_TOOLS}, {@link DORKOS_AGENT_TOOLS})
 * that {@link isAutoAllowedCall} also clears — and, for the owner-facing subset,
 * that this session has an agent identity ({@link IDENTITY_SCOPED_TOOLS}) — and
 * hands every remaining call to {@link resolveModeDecision}, which either allows
 * it or raises an approval card.
 *
 * Nothing reaches a person's machine on a fall-through: a tool that matches no
 * safe list and no permissive mode asks. `Bash` under `acceptEdits` asks, and so
 * does a rooms verb, or a proactive note, from a session that names nobody.
 *
 * @param session - The interactive session state (with its permission mode).
 * @param log - Where the gate reports its verdicts; see {@link ToolGateLogger}.
 * @param onToolPreflight - Optional hook fired for EVERY tool BEFORE it runs and
 *   before any approval wait — the synchronous pre-tool seam DorkOS uses to
 *   snapshot a file's pre-edit bytes for the diff base (DOR-212). Awaited so the
 *   snapshot is guaranteed captured before the SDK applies the edit; a rejection
 *   is swallowed by the caller's wiring so capture never blocks a tool.
 * @param resolveIdentity - Answers "whose identity does this session call as?",
 *   for {@link IDENTITY_SCOPED_TOOLS}. Defaults to a resolver over the session's
 *   own `cwd` — the SAME call `mcp-tools/index.ts` builds the capability
 *   resolver from, so the gate and the caller the tool runs as cannot disagree.
 *   Injectable so a test can state the identity instead of staging an agent on
 *   disk.
 */
export function createCanUseTool(
  session: InteractiveSession & { permissionMode: PermissionMode },
  log: ToolGateLogger,
  onToolPreflight?: (toolName: string, input: Record<string, unknown>) => Promise<void>,
  resolveIdentity: () => Promise<unknown> = createInSessionContextResolver(session.cwd)
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
      isAutoAllowedCall(toolName, input) &&
      // The owner-facing verbs skip the card only for a session that resolves an
      // agent identity: without one the rooms verbs run as the OWNER — who sees
      // every room on the install and posts as a person — and a proactive note
      // has no sender to be from (see IDENTITY_SCOPED_TOOLS).
      // The resolver memoizes, so this costs one indexed read per query however
      // many times the agent reaches for a room.
      (!IDENTITY_SCOPED_TOOLS.has(toolName) || (await hasAgentIdentity(resolveIdentity, log)))
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
      clearInteractionTimer(session, toolUseId);
      session.pendingInteractions.delete(toolUseId);
      notifyInteractionCancelled(session, toolUseId, 'aborted');
      deny(WITHDRAWN_DENIALS.approval);
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    const toolLabel = toolLabelFor(context.displayName, toolName);
    const waitedMs = refusalDeadlineMs(session);
    const timeout = armInteractionWait(
      session,
      toolUseId,
      {
        parked: approvalParkedNotice(toolLabel),
        expired: approvalTimeoutNotice(toolLabel, describeWaited(waitedMs)),
      },
      { kind: 'approval', toolName },
      () => {
        context.signal.removeEventListener('abort', onAbort);
        deny(approvalTimeoutDenial(waitedMs));
      }
    );

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
        clearInteractionTimer(session, toolUseId);
        context.signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(toolUseId);

        if (Array.isArray(result)) {
          // "Always Allow" — forward SDK permission suggestions
          resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: result });
        } else if (result) {
          resolve({ behavior: 'allow', updatedInput: input });
        } else {
          // The reason is the whole point of carrying one: told only "denied",
          // an agent typically retries the same call or stalls; told why, it can
          // take another route. A blank reason is treated as no reason — the
          // transcript receipt claims the agent was told why only when something
          // was actually delivered, so an empty string must not quietly become a
          // claim.
          deny(toolDenial(denyReason));
        }
      },
      reject: () => {
        clearInteractionTimer(session, toolUseId);
        context.signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(toolUseId);
        deny(WITHDRAWN_DENIALS.interaction);
      },
      timeout,
    });
  });
}
