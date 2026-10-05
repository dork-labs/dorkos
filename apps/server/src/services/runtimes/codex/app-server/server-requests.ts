/**
 * Codex's server → client requests, as DorkOS cards (spec
 * `codex-app-server-transport` §10).
 *
 * Every approval Codex asks for, every question it puts to the person and
 * every MCP elicitation arrives as a JSON-RPC request that BLOCKS the turn
 * until it is answered (protocol §4). This module turns each one into the
 * event the client draws (`approval_required`, `question_prompt`,
 * `elicitation_prompt`), holds it while a person decides, and writes exactly
 * one reply back.
 *
 * - **Who answers.** Only {@link CodexServerRequestBroker.answerApproval},
 *   {@link CodexServerRequestBroker.answerQuestion} and
 *   {@link CodexServerRequestBroker.answerElicitation}, which the runtime
 *   calls from `approveTool` / `submitAnswers` / `submitElicitation`, which the
 *   server calls only from person-authenticated routes. No agent, tool or MCP
 *   path reaches them, and nothing here ever accepts on its own (spec §18).
 * - **Timeout.** The card counts down for `SESSIONS.INTERACTION_TIMEOUT_MS`,
 *   then parks, exactly as Claude Code's and OpenCode's do (spec
 *   `ask-parks-on-timeout`). At `SESSIONS.INTERACTION_PARK_CEILING_MS` the
 *   request is declined (an elicitation cancelled), the card is withdrawn with
 *   `interaction_cancelled { reason: 'timeout' }`, and the agent carries on.
 * - **Abort.** Stopping the turn cancels every pending request of the session
 *   first, then interrupts (the transport's order).
 * - **Cleared by Codex.** `serverRequest/resolved` for a request DorkOS still
 *   holds (the turn ended, or another client answered it) withdraws the card
 *   with `interaction_cancelled { reason: 'aborted' }`; an answer after that
 *   is `false`.
 * - **Refused.** Requests DorkOS does not take part in (dynamic tools, token
 *   refresh, attestation, the legacy v1 approvals, elicitation modes it cannot
 *   draw) get the method's own "no" at once, and a log line.
 *
 * @module services/runtimes/codex/app-server/server-requests
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { SESSIONS } from '../../../../config/constants.js';
import { logger } from '../../../../lib/logger.js';
import { logRefusal } from '../../../observability/refusals.js';
import { PATCH_TOOL_NAME, SHELL_TOOL_NAME } from '../event-mapper.js';
import { refusalFor, type ServerRequest } from './protocol/methods.js';

/** The card a request draws. */
export type CodexInteractionKind = 'approval' | 'question' | 'elicitation';

/** The tool name a permissions request is shown under. */
export const PERMISSIONS_TOOL_NAME = 'Permissions';

/** What the transport knows about the turn a request belongs to. */
export interface ServerRequestTurnView {
  /** The input a tool start carried for an item, if the turn saw one. */
  inputOf(itemId: string): string | undefined;
  /** The MCP tool calls of one server still running in the turn. */
  runningMcpCalls(server: string): Array<{ id: string; tool: string; arguments: unknown }>;
}

/** How each answer is written back, per request. */
interface ReplyPlan {
  /** Approve, optionally for the rest of the session. */
  approve?(alwaysAllow: boolean): unknown;
  /** Deny. */
  deny?: unknown;
  /** Answer a question (canonical index-keyed answers). */
  answer?(answers: Record<string, string>): unknown;
  /** Answer an elicitation. */
  elicit?(action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): unknown;
  /** Nobody answered by the park ceiling. */
  readonly expired: unknown;
  /** The turn was stopped, or Codex cleared it. */
  readonly cancelled: unknown;
}

/** A request mapped to a card, or refused at once. */
export type MappedServerRequest =
  | {
      readonly refuse: unknown;
      readonly why: string;
      /** A line to tell the person in the turn, when the refusal is theirs to know about. */
      readonly notice?: string;
    }
  | {
      readonly kind: CodexInteractionKind;
      readonly interactionId: string;
      /** The card, without its timing fields (the broker stamps them). */
      readonly card: { type: StreamEvent['type']; data: Record<string, unknown> };
      /** The tool name, for the expiry log line. */
      readonly toolName: string;
      readonly replies: ReplyPlan;
    };

type Params = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * Map one server request to the card it draws and the replies it can take
 * (spec §10's table). Pure.
 *
 * @param request - The request as it arrived.
 * @param turn - What the open turn has seen.
 */
export function mapServerRequest(
  request: ServerRequest,
  turn: ServerRequestTurnView
): MappedServerRequest {
  const params = (request.params ?? {}) as Params;
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
      return commandApproval(request, params, turn);
    case 'item/fileChange/requestApproval':
      return fileChangeApproval(request, params, turn);
    case 'item/permissions/requestApproval':
      return permissionsApproval(request, params);
    case 'mcpServer/elicitation/request':
      return elicitation(request, params, turn);
    case 'item/tool/requestUserInput':
      return userInput(request, params);
    default:
      return {
        refuse: refusalFor(request.method) ?? undefined,
        why: 'DorkOS does not take part in this request',
      };
  }
}

/** `accept` / `acceptForSession` / `decline` / `cancel` decisions. */
function decisionReplies(sessionScoped: boolean): ReplyPlan {
  return {
    approve: (alwaysAllow) => ({
      decision: alwaysAllow && sessionScoped ? 'acceptForSession' : 'accept',
    }),
    deny: { decision: 'decline' },
    expired: { decision: 'decline' },
    cancelled: { decision: 'cancel' },
  };
}

function interactionIdOf(request: ServerRequest, params: Params): string {
  // `approvalId` names one ask when an item raises several (a command's
  // network hosts); otherwise the card attaches to the item's own tool start.
  return str(params.approvalId) ?? str(params.itemId) ?? `codex-request-${String(request.id)}`;
}

function commandApproval(
  request: ServerRequest,
  params: Params,
  turn: ServerRequestTurnView
): MappedServerRequest {
  const itemId = str(params.itemId);
  const decisions = Array.isArray(params.availableDecisions)
    ? (params.availableDecisions as unknown[])
    : undefined;
  // Codex lists the buttons it accepts; "for this session" only when it does.
  const sessionScoped = decisions === undefined || decisions.includes('acceptForSession');
  const network = params.networkApprovalContext as { host?: unknown } | null | undefined;
  const host = str(network?.host);
  const input =
    params.command !== undefined && params.command !== null
      ? JSON.stringify({ command: params.command, cwd: params.cwd })
      : ((itemId && turn.inputOf(itemId)) ?? '{}');
  return {
    kind: 'approval',
    interactionId: interactionIdOf(request, params),
    toolName: SHELL_TOOL_NAME,
    card: {
      type: 'approval_required',
      data: {
        toolName: SHELL_TOOL_NAME,
        input,
        ...(str(params.reason) ? { decisionReason: str(params.reason) } : {}),
        ...(host ? { description: `Codex wants to reach ${host}.` } : {}),
        hasSuggestions: sessionScoped,
        ...(sessionScoped ? { alwaysAllowScope: 'session' } : {}),
      },
    },
    replies: decisionReplies(sessionScoped),
  };
}

function fileChangeApproval(
  request: ServerRequest,
  params: Params,
  turn: ServerRequestTurnView
): MappedServerRequest {
  const itemId = str(params.itemId);
  return {
    kind: 'approval',
    interactionId: interactionIdOf(request, params),
    toolName: PATCH_TOOL_NAME,
    card: {
      type: 'approval_required',
      data: {
        toolName: PATCH_TOOL_NAME,
        input: (itemId && turn.inputOf(itemId)) ?? JSON.stringify({ changes: [] }),
        ...(str(params.reason) ? { decisionReason: str(params.reason) } : {}),
        ...(str(params.grantRoot) ? { blockedPath: str(params.grantRoot) } : {}),
        hasSuggestions: true,
        alwaysAllowScope: 'session',
      },
    },
    replies: decisionReplies(true),
  };
}

function permissionsApproval(request: ServerRequest, params: Params): MappedServerRequest {
  const requested = (params.permissions ?? {}) as Params;
  const none = { permissions: {}, scope: 'turn' };
  return {
    kind: 'approval',
    interactionId: interactionIdOf(request, params),
    toolName: PERMISSIONS_TOOL_NAME,
    card: {
      type: 'approval_required',
      data: {
        toolName: PERMISSIONS_TOOL_NAME,
        input: JSON.stringify(requested),
        ...(str(params.reason) ? { decisionReason: str(params.reason) } : {}),
        hasSuggestions: true,
        alwaysAllowScope: 'session',
      },
    },
    replies: {
      // Exactly what was asked for, never more; anything omitted is denied.
      approve: (alwaysAllow) => ({
        permissions: requested,
        scope: alwaysAllow ? 'session' : 'turn',
      }),
      deny: none,
      expired: none,
      cancelled: none,
    },
  };
}

function elicitation(
  request: ServerRequest,
  params: Params,
  turn: ServerRequestTurnView
): MappedServerRequest {
  const server = str(params.serverName) ?? 'mcp';
  const meta = (params._meta ?? null) as Params | null;
  const cancel = { action: 'cancel', content: null, _meta: null };
  const decline = { action: 'decline', content: null, _meta: null };
  const approval =
    meta?.codex_approval_kind === 'mcp_tool_call'
      ? mcpToolApproval(request, params, server, turn)
      : undefined;
  if (approval) return approval;
  const mode = params.mode;
  if (mode !== 'form' && mode !== 'url') {
    return { refuse: cancel, why: `DorkOS cannot draw a ${String(mode)} elicitation` };
  }
  const interactionId =
    (mode === 'url' ? str(params.elicitationId) : undefined) ??
    `codex-elicitation-${String(request.id)}`;
  return {
    kind: 'elicitation',
    interactionId,
    toolName: `mcp__${server}`,
    card: {
      type: 'elicitation_prompt',
      data: {
        serverName: server,
        message: str(params.message) ?? '',
        mode,
        ...(mode === 'url'
          ? { url: str(params.url), elicitationId: str(params.elicitationId) }
          : {}),
        ...(mode === 'form' && typeof params.requestedSchema === 'object'
          ? { requestedSchema: params.requestedSchema }
          : {}),
      },
    },
    replies: {
      elicit: (action, content) => ({
        action,
        content: action === 'accept' ? (content ?? {}) : null,
        _meta: null,
      }),
      expired: cancel,
      cancelled: cancel,
    },
  };
}

/** `Allow the srv MCP server to run tool "delete_repo"?` (0.154's wording). */
const MCP_APPROVAL_TOOL = /run tool "([^"]+)"/;

/**
 * An MCP tool call waiting on the person (0.154: a `form` elicitation with an
 * empty schema, `_meta.codex_approval_kind: "mcp_tool_call"`, the call's
 * arguments in `_meta.tool_params`, and the tool named only in the message).
 *
 * The kind is a label any MCP server can put on its own elicitation, so it is
 * trusted only when the request asks for nothing (no fields, no url) AND the
 * turn has a running call of that server and that tool. One such call: the
 * card is that call's, with that call's input. Several: a card of its own,
 * with the request's own arguments, so the person never approves one call
 * while looking at another. None: not an approval at all (`undefined`), and
 * it is drawn as the plain elicitation it is.
 */
function mcpToolApproval(
  request: ServerRequest,
  params: Params,
  server: string,
  turn: ServerRequestTurnView
): MappedServerRequest | undefined {
  const meta = params._meta as Params;
  const schema = params.requestedSchema as { properties?: object } | undefined;
  const asksForFields =
    schema !== undefined &&
    schema !== null &&
    typeof schema.properties === 'object' &&
    schema.properties !== null &&
    Object.keys(schema.properties).length > 0;
  if (params.mode !== 'form' || params.url !== undefined || asksForFields) return undefined;
  const tool = str(meta.tool_name) ?? MCP_APPROVAL_TOOL.exec(str(params.message) ?? '')?.[1];
  if (tool === undefined) return undefined;
  const matches = turn.runningMcpCalls(server).filter((call) => call.tool === tool);
  if (matches.length === 0) return undefined;
  const only = matches.length === 1 ? matches[0]! : undefined;
  const toolName = `mcp__${server}__${tool}`;
  const decline = { action: 'decline', content: null, _meta: null };
  return {
    kind: 'approval',
    interactionId: only?.id ?? `codex-request-${String(request.id)}`,
    toolName,
    card: {
      type: 'approval_required',
      data: {
        toolName,
        input: JSON.stringify(only ? (only.arguments ?? {}) : (meta.tool_params ?? {})),
        ...(str(params.message) ? { description: str(params.message) } : {}),
        hasSuggestions: false,
      },
    },
    replies: {
      approve: () => ({ action: 'accept', content: null, _meta: null }),
      deny: decline,
      expired: decline,
      cancelled: { action: 'cancel', content: null, _meta: null },
    },
  };
}

interface CodexQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: Array<{ label: string; description?: string }> | null;
}

/** What the person reads when Codex asks for a secret (app copy, one block). */
export const SECRET_QUESTION_NOTICE =
  'Codex asked for a secret. DorkOS can’t take secrets here yet, so it was skipped.';

/**
 * `item/tool/requestUserInput` → a question card. Every card offers a typed
 * "Other" answer, which is Codex's `isOther`; a typed answer is passed through
 * as written either way.
 *
 * A question marked `isSecret` is not drawn: the card has no masked input
 * (DOR-2726), so a password typed there would sit in the transcript in the
 * clear. The request is answered with nothing, and the person is told why.
 */
function userInput(request: ServerRequest, params: Params): MappedServerRequest {
  const questions = (Array.isArray(params.questions) ? params.questions : []) as CodexQuestion[];
  const none = { answers: {} };
  if (questions.some((question) => question.isSecret === true)) {
    return {
      refuse: none,
      why: 'a secret question needs masked input (DOR-2726)',
      notice: SECRET_QUESTION_NOTICE,
    };
  }
  return {
    kind: 'question',
    interactionId: interactionIdOf(request, params),
    toolName: 'AskUserQuestion',
    card: {
      type: 'question_prompt',
      data: {
        questions: questions.map((question) => ({
          header: question.header ?? '',
          question: question.question,
          options: (question.options ?? []).map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
          multiSelect: false,
        })),
      },
    },
    replies: {
      // Canonical answers are keyed by question index, and only by index;
      // Codex keys by question id.
      answer: (answers) => ({
        answers: Object.fromEntries(
          questions.flatMap((question, index) => {
            const key = String(index);
            const value = Object.hasOwn(answers, key) ? answers[key] : undefined;
            return typeof value === 'string' ? [[question.id, { answers: [value] }]] : [];
          })
        ),
      }),
      expired: none,
      cancelled: none,
    },
  };
}

/** One request a person has not answered yet. */
interface PendingRequest {
  readonly sessionId: string;
  readonly processKey: string;
  readonly jsonRpcId: number | string;
  readonly interactionId: string;
  readonly kind: CodexInteractionKind;
  readonly toolName: string;
  readonly startedAt: number;
  readonly replies: ReplyPlan;
  readonly settle: (result: unknown) => void;
  readonly emit: (events: StreamEvent[]) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Options for {@link CodexServerRequestBroker}. */
export interface ServerRequestBrokerOptions {
  /** The countdown the card shows (default `SESSIONS.INTERACTION_TIMEOUT_MS`). */
  readonly countdownMs?: number;
  /** When nobody answered, and the request is declined (default the park ceiling). */
  readonly expireMs?: number;
}

/** Holds Codex's pending requests until a person answers them. */
export class CodexServerRequestBroker {
  /** Session → interaction id → pending request. */
  private readonly pending = new Map<string, Map<string, PendingRequest>>();
  private readonly countdownMs: number;
  private readonly expireMs: number;

  /**
   * Construct an empty broker.
   *
   * @param options - Timing.
   */
  constructor(options: ServerRequestBrokerOptions = {}) {
    this.countdownMs = options.countdownMs ?? SESSIONS.INTERACTION_TIMEOUT_MS;
    this.expireMs = options.expireMs ?? SESSIONS.INTERACTION_PARK_CEILING_MS;
  }

  /**
   * Draw a mapped request's card into its turn and wait for an answer. The
   * returned promise settles with the reply to write, exactly once.
   *
   * @param entry - Where the request came from, the mapped card, and how to
   *   push events into its turn.
   */
  open(entry: {
    sessionId: string;
    processKey: string;
    jsonRpcId: number | string;
    mapped: Extract<MappedServerRequest, { kind: CodexInteractionKind }>;
    emit: (events: StreamEvent[]) => void;
  }): Promise<unknown> {
    const { mapped, sessionId } = entry;
    // A re-sent id replaces the record it would otherwise shadow. The old
    // request is declined, never cancelled: a cancel stops the whole turn.
    this.take(sessionId, mapped.interactionId)?.settle(mapped.replies.expired);
    const startedAt = Date.now();
    let settle!: (result: unknown) => void;
    const reply = new Promise<unknown>((resolve) => (settle = resolve));
    const timer = setTimeout(() => this.expire(sessionId, mapped.interactionId), this.expireMs);
    timer.unref?.();
    let forSession = this.pending.get(sessionId);
    if (!forSession) {
      forSession = new Map();
      this.pending.set(sessionId, forSession);
    }
    forSession.set(mapped.interactionId, {
      sessionId,
      processKey: entry.processKey,
      jsonRpcId: entry.jsonRpcId,
      interactionId: mapped.interactionId,
      kind: mapped.kind,
      toolName: mapped.toolName,
      startedAt,
      replies: mapped.replies,
      settle,
      emit: entry.emit,
      timer,
    });
    const idField = mapped.kind === 'elicitation' ? 'interactionId' : 'toolCallId';
    entry.emit([
      {
        type: mapped.card.type,
        data: {
          [idField]: mapped.interactionId,
          ...mapped.card.data,
          timeoutMs: this.countdownMs,
          startedAt,
        },
      } as StreamEvent,
    ]);
    return reply;
  }

  /**
   * A person approved or denied a card. `false` when nothing approvable is
   * pending under that id (answered, cleared, expired, or not an approval).
   *
   * @param sessionId - The session.
   * @param interactionId - The card's `toolCallId`.
   * @param approved - The decision.
   * @param alwaysAllow - Approve for the rest of the session, where offered.
   */
  answerApproval(
    sessionId: string,
    interactionId: string,
    approved: boolean,
    alwaysAllow = false
  ): boolean {
    const entry = this.peek(sessionId, interactionId);
    if (entry?.kind !== 'approval') return false;
    this.take(sessionId, interactionId);
    entry.settle(approved ? entry.replies.approve!(alwaysAllow) : entry.replies.deny);
    return true;
  }

  /**
   * A person answered a question card.
   *
   * @param sessionId - The session.
   * @param interactionId - The card's `toolCallId`.
   * @param answers - Canonical answers, keyed by question index.
   */
  answerQuestion(
    sessionId: string,
    interactionId: string,
    answers: Record<string, string>
  ): boolean {
    const entry = this.peek(sessionId, interactionId);
    if (entry?.kind !== 'question') return false;
    this.take(sessionId, interactionId);
    entry.settle(entry.replies.answer!(answers));
    return true;
  }

  /**
   * A person answered an elicitation card.
   *
   * @param sessionId - The session.
   * @param interactionId - The card's `interactionId`.
   * @param action - Accept, decline or cancel.
   * @param content - The form's content, on accept.
   */
  answerElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ): boolean {
    const entry = this.peek(sessionId, interactionId);
    if (entry?.kind !== 'elicitation') return false;
    this.take(sessionId, interactionId);
    entry.settle(entry.replies.elicit!(action, content));
    return true;
  }

  /**
   * The turn is being stopped: cancel every pending request of the session
   * and withdraw its cards.
   *
   * @param sessionId - The session.
   * @returns How many requests were cancelled.
   */
  cancelSession(sessionId: string): number {
    const entries = this.drain(sessionId);
    for (const entry of entries) {
      entry.emit([interactionCancelled(entry.interactionId, 'aborted')]);
      entry.settle(entry.replies.cancelled);
    }
    return entries.length;
  }

  /**
   * Codex cleared a request (`serverRequest/resolved`): if DorkOS still holds
   * it, drop it and withdraw its card.
   *
   * @param processKey - The process the notification came from.
   * @param jsonRpcId - The cleared request's id.
   */
  resolvedByServer(processKey: string, jsonRpcId: unknown): void {
    for (const forSession of this.pending.values()) {
      for (const entry of forSession.values()) {
        if (entry.processKey !== processKey || entry.jsonRpcId !== jsonRpcId) continue;
        this.take(entry.sessionId, entry.interactionId);
        entry.emit([interactionCancelled(entry.interactionId, 'aborted')]);
        // Answered once all the same; Codex ignores a reply to a cleared request.
        entry.settle(entry.replies.cancelled);
        return;
      }
    }
  }

  /**
   * Forget a session's requests without a word (its turn already ended, or
   * its process is gone). Each still gets its one reply.
   *
   * @param sessionId - The session.
   */
  dropSession(sessionId: string): void {
    for (const entry of this.drain(sessionId)) entry.settle(entry.replies.cancelled);
  }

  private expire(sessionId: string, interactionId: string): void {
    const entry = this.take(sessionId, interactionId);
    if (!entry) return;
    const waitedMs = Date.now() - entry.startedAt;
    // The durable trace an expired prompt leaves (DOR-803), like the other runtimes'.
    logRefusal(
      `[codex] nobody answered in ${Math.round(waitedMs / 60_000)}m, so this was declined`,
      {
        reason: 'interaction_expired',
        visibility: 'silent',
        sessionId,
        detail: { interactionId, kind: entry.kind, toolName: entry.toolName, waitedMs },
      }
    );
    entry.emit([interactionCancelled(interactionId, 'timeout')]);
    entry.settle(entry.replies.expired);
  }

  private peek(sessionId: string, interactionId: string): PendingRequest | undefined {
    return this.pending.get(sessionId)?.get(interactionId);
  }

  private take(sessionId: string, interactionId: string): PendingRequest | undefined {
    const forSession = this.pending.get(sessionId);
    const entry = forSession?.get(interactionId);
    if (!forSession || !entry) return undefined;
    clearTimeout(entry.timer);
    forSession.delete(interactionId);
    if (forSession.size === 0) this.pending.delete(sessionId);
    return entry;
  }

  private drain(sessionId: string): PendingRequest[] {
    const entries = [...(this.pending.get(sessionId)?.values() ?? [])];
    for (const entry of entries) this.take(sessionId, entry.interactionId);
    return entries;
  }
}

function interactionCancelled(interactionId: string, reason: 'aborted' | 'timeout'): StreamEvent {
  return { type: 'interaction_cancelled', data: { interactionId, reason } } as StreamEvent;
}

/**
 * Log a request DorkOS refused at once (never its content).
 *
 * @param method - The request's method.
 * @param why - Why it was refused.
 */
export function logRefusedServerRequest(method: string, why: string): void {
  logger.info('[CodexAppServer] refused a server request', { method, why });
}
