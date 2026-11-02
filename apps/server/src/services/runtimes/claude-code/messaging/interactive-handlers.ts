import type {
  PermissionResult,
  PermissionUpdate,
  ElicitationRequest,
  ElicitationResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { QuestionItem } from '@dorkos/shared/types';
import { QuestionItemSchema } from '@dorkos/shared/schemas';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import {
  createInSessionContextResolver,
  resolveAgentHome,
} from '../../../core/agent-identity/index.js';
import { SESSIONS } from '../../../../config/constants.js';
import { logger } from '../../../../lib/logger.js';
import { logRefusal } from '../../../observability/refusals.js';
import { NEVER_ASK_REASON_TYPE, NO_APPROVAL_SURFACE } from '@dorkos/shared/run-refusals';
import { alwaysAllowScopeOf, suggestionDestinations } from './always-allow-scope.js';
import { keepAlwaysAllowToAgent } from '../tool-gate/global-server-always-allow.js';
import {
  armInteractionWait,
  approvalParkedNotice,
  approvalTimeoutNotice,
  clearInteractionTimer,
  elicitationParkedNotice,
  elicitationTimeoutNotice,
  ASK_KIND_ON_THE_WIRE,
  NOBODY_TO_ASK_REASON,
  nobodyToAsk,
  notifyInteractionCancelled,
  questionParkedNotice,
  questionTimeoutNotice,
  toolLabelFor,
  type InteractiveSession,
} from './interaction-wait.js';
import { toSdkQuestionAnswers } from '../sessions/question-answers.js';
import { IN_SESSION_TOOL_PREFIX, isHostServedOrUnattributed } from '../mcp-tools/tool-exposure.js';
import { recordAutoModeStop } from '../../../observability/auto-mode-stops.js';
import {
  approvalTimeoutDenial,
  describeWaited,
  NEVER_ASK_DENIAL,
  NO_APPROVAL_SURFACE_DENIAL,
  questionTimeoutDenial,
  toolDenial,
  WITHDRAWN_DENIALS,
} from '../sessions/tool-result-outcome.js';
import { randomUUID } from 'node:crypto';
import {
  autoAllowedByCall,
  DORKOS_AGENT_TOOLS,
  hasAgentIdentity,
  IDENTITY_SCOPED_TOOLS,
} from '../tool-gate/auto-allow.js';
import {
  carriesOutsiderMark,
  chosenFullAutonomy,
  gatePermissionMode,
  neverAsks,
  resolveModeDecision,
  type CeilingedMode,
} from '../turn-permission.js';

/** Why the Never ask mode refused a call, in a person's words (the denial chip). */
const NEVER_ASK_REASON = 'Never ask refuses anything not already allowed.';

/** The SDK's own ask-the-person tool, which is routed rather than approved. */
const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * Refuse an ask that reached a session with nobody to answer it, and leave a
 * record of it (spec `unattended-session-permission-prompts`).
 *
 * ## Why this is a refusal and not a shorter wait
 *
 * A scheduled run used to refuse an unanswered prompt after ten minutes instead
 * of parking for four hours. Those ten minutes bought a chance that somebody
 * answers on the one surface where, by construction, nobody is there — and the
 * session declined reclaim for the whole of it, so one abandoned prompt at 3am
 * could crowd out an agent a person actually launched. Refusing at the moment
 * the ask is raised costs nothing that could have been saved.
 *
 * ## What it is deliberately NOT
 *
 * It is not a gate. Everything that decides whether an ask happens at all runs
 * first and is untouched: the CLI's own permission engine, then the safe lists
 * and {@link isAutoAllowedCall}, then {@link resolveModeDecision} — which means
 * a `bypassPermissions` schedule still allows exactly what it always allowed,
 * including the handful of calls the CLI escalates under that mode. Only an ask
 * that would otherwise sit and WAIT reaches here.
 *
 * ## The record
 *
 * A `permission_denied` StreamEvent stamped {@link NO_APPROVAL_SURFACE} — the
 * `reasonType` DorkOS writes for an absent person, and the reason a run summary
 * may say "nobody was there to approve it" without qualifying it. It carries `askKind`
 * beside the reason, because this one function refuses three different asks
 * and only a TOOL is one the run lost the ability to act with (DOR-2101); a
 * run that did its work and closed by asking a question must not be recorded
 * as one that could not use its tools. The SDK's `classifier` and `rule`
 * denials describe decisions that would have gone the same way with a person
 * present, so `@dorkos/shared/run-refusals` ignores them; its `asyncAgent` and
 * `mode` denials are counted there too, each with words of its own. The event rides
 * the session's own queue, so it reaches the live client, the transcript, and
 * the scheduler consuming the run's stream, with no new plumbing.
 *
 * Plus one log line, per the refusal rule (`observability/refusals.ts`), at
 * `warn` and `visibility: 'silent'` — nothing was shown to anybody, because
 * there was nobody to show it to.
 *
 * @param session - The session whose ask is being refused.
 * @param ask.interactionId - The tool-use id, or the elicitation's own id.
 * @param ask.kind - Which of the three kinds of prompt this was.
 * @param ask.toolName - The tool, or the MCP server that asked.
 */
function refuseWithNobodyToAsk(
  session: InteractiveSession,
  ask: {
    interactionId: string;
    kind: 'approval' | 'question' | 'elicitation';
    toolName: string;
  }
): void {
  session.eventQueue.push({
    type: 'permission_denied',
    data: {
      toolCallId: ask.interactionId,
      toolName: ask.toolName,
      reasonType: NO_APPROVAL_SURFACE,
      // Written in the SAME statement as the reason, so a reader can never get
      // one without the other. `approval` is the only one of the three that is
      // a tool the run wanted to act with; the other two are the run wanting
      // to talk to somebody (DOR-2101).
      askKind: ASK_KIND_ON_THE_WIRE[ask.kind],
      reason: NOBODY_TO_ASK_REASON[ask.kind],
      // The same words the model was handed, so the chip and the transcript
      // cannot describe the refusal differently from the refusal itself.
      message: NO_APPROVAL_SURFACE_DENIAL,
    },
  });
  session.eventQueueNotify?.();

  logRefusal('[claude-code] nobody could approve this on a scheduled run, so it was refused', {
    reason: 'no_approval_surface',
    // Nobody was shown anything: there is no client on an unattended run, which
    // is the whole premise. The run's own summary and the activity feed are
    // where a person finds this afterwards, built from the event above.
    visibility: 'silent',
    ...(session.sdkSessionId !== undefined ? { sessionId: session.sdkSessionId } : {}),
    detail: {
      interactionId: ask.interactionId,
      kind: ask.kind,
      toolName: ask.toolName,
    },
  });
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
  // Parse rather than cast, so the live `question_prompt` event, the parked
  // notice and the snapshot carry the same defaults (`multiSelect: false`,
  // `header: ''`) history does. Without them the client's schema rejected the
  // live event outright (DOR-2075). An input the schema cannot read keeps the
  // raw value: the SDK has already validated it, and refusing here would
  // strand the turn over a shape question.
  const parsed = QuestionItemSchema.array().safeParse(input.questions);
  if (!parsed.success) {
    // The client cannot render this question and shows a placeholder instead
    // (DOR-2078), so this line is where the defect behind it gets found.
    logger.warn('[handleAskUserQuestion] question input does not match the schema', {
      toolUseId,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  const questions = parsed.success ? parsed.data : (input.questions as QuestionItem[]);
  if (nobodyToAsk(session)) {
    refuseWithNobodyToAsk(session, {
      interactionId: toolUseId,
      kind: 'question',
      toolName: ASK_USER_QUESTION_TOOL,
    });
    return Promise.resolve({ behavior: 'deny', message: NO_APPROVAL_SURFACE_DENIAL });
  }
  const startedAt = Date.now();
  session.eventQueue.push({
    type: 'question_prompt',
    data: {
      toolCallId: toolUseId,
      questions,
      // `startedAt` and `timeoutMs` were missing here while `handleToolApproval`
      // carried both — the normalizer's `remainingMs: data.remainingMs ??
      // data.timeoutMs ?? 0` had nothing to fall back to but `0`, so a LIVE
      // question landed with a dead countdown while the recovery snapshot (which
      // recomputes `remainingMs` from `startedAt` + this same budget) showed the
      // real deadline. Matching `handleToolApproval` is the fix (DOR-1323).
      //
      // All three handlers now stamp the same two facts (DOR-1442), which is
      // what lets the anchor be the HANDLER's clock everywhere. Left to the
      // normalizer's `?? Date.now()`, one prompt would be anchored where it was
      // raised and another where it happened to be normalized.
      startedAt,
      timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
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

    const waitedMs = SESSIONS.INTERACTION_PARK_CEILING_MS;
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
      startedAwake: performance.now(),
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
  if (nobodyToAsk(session)) {
    // The MCP server is named where a tool name would go: it is what the person
    // reading the run has to recognise, and this record's whole job is to say
    // WHAT could not be answered.
    refuseWithNobodyToAsk(session, {
      interactionId,
      kind: 'elicitation',
      toolName: request.serverName,
    });
    return Promise.resolve({ action: 'decline' } as ElicitationResult);
  }
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
      // The same anchor + budget pair the other two handlers push. `startedAt`
      // used to reach the pending-interaction record below and nothing else, so
      // the durable member fell back to the normalizer's `Date.now()` — the
      // event was anchored where it was NORMALIZED while its own recovery DTO
      // was anchored where it was RAISED, and the two disagreed about when the
      // clock started (DOR-1442).
      startedAt,
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
          describeWaited(SESSIONS.INTERACTION_PARK_CEILING_MS)
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
      startedAwake: performance.now(),
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
   * BACKGROUNDED (async) subagents are the handled case, and they are handled
   * SOMEWHERE ELSE (DOR-795). The CLI does not escalate their asks to this
   * callback — a detached child has nobody to ask — it auto-denies and reports
   * the refusal as a `permission_denied` system message on the parent's stream.
   * SDK 0.3.224 says both halves out loud: `SDKPermissionDeniedMessage`'s
   * docblock names "headless-agent auto-deny" among the cases it covers and
   * carries the child's `agent_id`, and `asyncAgent` appears as a
   * `decision_reason_type` on that message as well as on
   * `SDKControlPermissionRequest`. So DorkOS surfaces the loss where it lands:
   * the system-event mapper turns that message into a `permission_denied`
   * StreamEvent, which is recorded durably and drawn as an attributed denial
   * chip naming the child and the tool it lost.
   *
   * This callback is deliberately left alone by that work, because it is already
   * correct for BOTH SDK branches. `asyncAgent` remains in the request wire's
   * `decision_reason_type` list, so if a future CLI ever does escalate a
   * backgrounded child's ask, it arrives here as an ordinary approval carrying
   * this `agentID` and raises a normal card — no new code path, no gap.
   */
  agentID?: string;
  title?: string;
  displayName?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
  suggestions?: PermissionUpdate[];
  /**
   * For `mcp__*` tools, the server serving the call and where it was defined
   * (SDK 0.3.274). `source: 'sdk'` is a server this host registered in-process;
   * anything else came from configuration. Absent for non-MCP tools and on
   * older CLIs. The auto-allow reads it through `isHostServedOrUnattributed`.
   */
  mcpServer?: { name: string; source: string };
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
 *   for {@link IDENTITY_SCOPED_TOOLS}. A launch hands in the resolver over the
 *   SAME identity anchor it hands `mcp-tools/index.ts`, so the gate and the
 *   caller the tool runs as cannot disagree; the default anchors the session's
 *   own `cwd`, for a caller with nothing better.
 *   Injectable so a test can state the identity instead of staging an agent on
 *   disk.
 */
export function createCanUseTool(
  session: InteractiveSession & CeilingedMode<PermissionModeId>,
  log: ToolGateLogger,
  onToolPreflight?: (toolName: string, input: Record<string, unknown>) => Promise<void>,
  resolveIdentity: () => Promise<unknown> = createInSessionContextResolver(
    resolveAgentHome(session.cwd)
  )
): (
  toolName: string,
  input: Record<string, unknown>,
  context: ToolApprovalContext
) => Promise<PermissionResult> {
  return async (toolName, input, context) => {
    if (onToolPreflight) await onToolPreflight(toolName, input);
    // A chat SET to Full autonomy asks nobody anything (DOR-3394): a mark, a
    // carried ceiling or a stranger's hold may have launched the turn lower, but
    // what it asks about is decided by the level the person chose. Below Full,
    // the turn's mode, not the session's: a turn held to a ceiling must not be
    // auto-allowed on the strength of the level a person chose for others, and
    // nor may background work an earlier ceilinged turn left running.
    const full = chosenFullAutonomy(session);
    const decision = full ? 'allow' : resolveModeDecision(gatePermissionMode(session));
    // "Never ask": `neverAsks` also covers a chat set to it whose turn a
    // stricter ceiling holds to Plan, which would otherwise ask.
    const refusing = decision === 'refuse' || neverAsks(session);
    if (
      // Under Never ask only DorkOS's own tools pass here (DOR-3042). The
      // CLI's read-only tools are still refused: `WebFetch` among them would
      // let an unattended run reach a page nobody chose.
      (!refusing || DORKOS_AGENT_TOOLS.has(toolName)) &&
      autoAllowedByCall(session, toolName, input, context.mcpServer) &&
      // The owner-facing verbs skip the card only for a session that resolves an
      // agent identity: without one the rooms verbs run as the OWNER (see
      // IDENTITY_SCOPED_TOOLS). The resolver memoizes.
      (!IDENTITY_SCOPED_TOOLS.has(toolName) || (await hasAgentIdentity(resolveIdentity, log)))
    ) {
      log.debug('[canUseTool] auto-allow safe tool', { toolName, toolUseID: context.toolUseID });
      return { behavior: 'allow', updatedInput: input };
    }

    // "Never ask" refuses what any other mode would ask about, the question
    // included: in this mode nobody is asked and nothing extra runs. DorkOS's
    // own safe-listed calls above are not among them: they run without asking
    // in every mode, so refusing them here would refuse what never asks, and a
    // Never ask run could not read or post to its own room (DOR-3042).
    if (refusing) {
      log.info('[canUseTool] refused: the chat is set to never ask', {
        toolName,
        toolUseID: context.toolUseID,
      });
      // The deny is decided before the record is written, so it never depends
      // on the record: a push that throws still refuses the call.
      const denied: PermissionResult = { behavior: 'deny', message: NEVER_ASK_DENIAL };
      // The record, with the CLI's own discriminator for a mode's refusal, so
      // a scheduled run's row can name the tool it lost (DOR-3132). The CLI
      // refuses most such calls itself and writes the same frame; this is the
      // one that reaches DorkOS's gate. A question is the run wanting to talk,
      // not to act, so it is left out of a record that names lost tools.
      if (toolName !== ASK_USER_QUESTION_TOOL) {
        try {
          session.eventQueue.push({
            type: 'permission_denied',
            data: {
              toolCallId: context.toolUseID,
              toolName,
              reasonType: NEVER_ASK_REASON_TYPE,
              // The person's words, which the denial chip shows; `message` is
              // what the model was told, and is not for a person to read.
              reason: NEVER_ASK_REASON,
              message: NEVER_ASK_DENIAL,
              ...(context.agentID !== undefined ? { agentId: context.agentID } : {}),
            },
          });
          session.eventQueueNotify?.();
        } catch (err) {
          log.info('[canUseTool] could not record a never-ask refusal', {
            toolName,
            toolUseID: context.toolUseID,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return denied;
    }
    if (toolName === ASK_USER_QUESTION_TOOL) {
      log.debug('[canUseTool] routing to question handler', {
        toolName,
        toolUseID: context.toolUseID,
      });
      return handleAskUserQuestion(session, context.toolUseID, input, context.signal);
    }

    // Anything but an explicit `allow` asks, so a decision added later can
    // never fall through to the auto-allow below.
    if (decision !== 'allow') {
      // The measurement (spec `auto-mode-classifier-context`). Reaching here in
      // AUTO mode with a DorkOS tool means the runtime's classifier decided this
      // call deserved a person, and DorkOS's own auto-allow list did not cover
      // it — which is exactly the stop the host-context note exists to remove.
      // Only `auto`: every other mode asks by design, so counting its cards
      // would bury the signal under the modes that are supposed to produce them.
      if (
        session.permissionMode === 'auto' &&
        toolName.startsWith(IN_SESSION_TOOL_PREFIX) &&
        // A configured server wearing the `dorkos` name is not a DorkOS tool,
        // and its stops are not the ones this measurement counts.
        isHostServedOrUnattributed(context.mcpServer)
      ) {
        recordAutoModeStop({ sessionId: session.sdkSessionId ?? 'unknown', toolName });
      }
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
      // A held turn offers no "Always allow" (DOR-3204): it must not write a
      // standing rule into the folder.
      const offered = carriesOutsiderMark(session) ? { ...context, suggestions: [] } : context;
      // A yes on a server for every agent's tool stays with this agent (DOR-3213 T9).
      return handleToolApproval(
        session,
        context.toolUseID,
        toolName,
        input,
        keepAlwaysAllowToAgent(toolName, offered)
      );
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
  if (nobodyToAsk(session)) {
    refuseWithNobodyToAsk(session, { interactionId: toolUseId, kind: 'approval', toolName });
    return Promise.resolve({ behavior: 'deny', message: NO_APPROVAL_SURFACE_DENIAL });
  }
  const startedAt = Date.now();
  // What "Always Allow" on this card would actually grant. Named on the card so
  // the click is informed, and logged in raw SDK terms so a week of real cards
  // can answer whether wide destinations turn up often enough to be worth
  // stripping — the follow-up question DOR-1462 deliberately left open.
  const alwaysAllowScope = alwaysAllowScopeOf(context.suggestions);
  if (alwaysAllowScope !== undefined) {
    logger.info('[handleToolApproval] always-allow suggestions offered', {
      toolName,
      toolUseID: toolUseId,
      scope: alwaysAllowScope,
      destinations: suggestionDestinations(context.suggestions),
    });
  }

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
      ...(alwaysAllowScope !== undefined ? { alwaysAllowScope } : {}),
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
    const waitedMs = SESSIONS.INTERACTION_PARK_CEILING_MS;
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
      startedAwake: performance.now(),
      snapshot: {
        toolName,
        input: JSON.stringify(input),
        title: context.title,
        displayName: context.displayName,
        description: context.description,
        blockedPath: context.blockedPath,
        decisionReason: context.decisionReason,
        hasSuggestions: (context.suggestions?.length ?? 0) > 0,
        ...(alwaysAllowScope !== undefined ? { alwaysAllowScope } : {}),
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
