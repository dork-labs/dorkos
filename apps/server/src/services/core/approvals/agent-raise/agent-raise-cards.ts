/**
 * An agent's request to raise a front-door setting, asked on a card (DOR-4355 M4,
 * Security's ruling C).
 *
 * Over HTTP an agent can't confirm it's the owner, so a front-door raise it asks
 * for used to be refused outright. A route that can describe what the raise does
 * may instead put it on a card: the person sees the effect the server computed,
 * from → to, says yes with the same step-up any other front-door yes needs, and
 * DorkOS then runs the stored write once, as the agent, scoped to exactly what the
 * agent asked for. Nothing the agent sends shapes the card's words.
 *
 * - Authority comes from the person's yes; scope comes from the stored request.
 *   The write runs with the agent's own writer, so nothing an owner-only branch
 *   would add is added.
 * - One card per agent per target: a newer ask replaces the older one. At most
 *   {@link MAX_PENDING_PER_AGENT} wait per agent; past that the agent is told to
 *   wait (429).
 * - Single use, and short-lived: {@link AGENT_RAISE_TTL_MS} after it is raised, or
 *   once the agent's turn is marked by outside words, the card is turned down and
 *   the agent has to ask again.
 * - A marked turn, or an agent header DorkOS can't resolve, gets no card (403).
 * - The write itself re-reads the state it was judged on, inside its own write,
 *   and answers 409 when that moved (each route's `run`).
 *
 * @module services/core/approvals/agent-raise/agent-raise-cards
 */
import type { ApprovalService } from '../approval-service.js';
import { hashApprovalInput } from '../approval-input-hash.js';
import { recordAudit } from '../../../audit/audit-trail.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import { marksOf } from '../../turn-power/turn-levels.js';
import { marksHold } from '../../turn-power/turn-marks.js';
import { chatReadOutsideWords } from '../../turn-power/chat-outside-words.js';

/** Every agent-raise card's capability id starts with this. */
export const AGENT_RAISE_PREFIX = 'agent-raise.';
/** How long a card stays answerable before the agent has to ask again. */
export const AGENT_RAISE_TTL_MS = 10 * 60_000;
/** How many cards one agent may have waiting at once. */
export const MAX_PENDING_PER_AGENT = 3;

/** One thing the raise changes, as the server read it. */
export interface AgentRaiseChange {
  /** What changes, in plain words, e.g. `Who may approve on “Northwind Slack”`. */
  what: string;
  /** How it is now. */
  from: string;
  /** How it would be. */
  to: string;
}

/** What the card says a raise does, computed by the server from stored state. */
export interface AgentRaiseEffect {
  /** One sentence for the card's summary. */
  summary: string;
  /** Each change, from → to. */
  changes: readonly AgentRaiseChange[];
}

/** A raise a route offers to put on a card. */
export interface AgentRaiseWrite {
  /** The kind of raise, e.g. `relay.allowlist`; the card's capability is `agent-raise.<kind>`. */
  kind: string;
  /** What it acts on, in the server's words. One card per agent per target. */
  target: string;
  /** Exactly what will run; its hash binds the card. */
  input: unknown;
  /** The effect the card shows. */
  effect: AgentRaiseEffect;
  /**
   * Run the stored write once, as the agent. It must re-read the state the effect
   * was computed from inside its own write and answer 409 when that moved.
   */
  run: () => Promise<{ status: number; body: unknown }>;
}

/** Who asked, as the request's verified facts name them. */
export interface AgentRaiseCaller {
  /** The verified agent, or `undefined` when none resolved. */
  identity: AgentIdentity | undefined;
  /** Whether the request presented an agent header at all. */
  presentsAgent: boolean;
  /** The calling chat, when the surface knows it. */
  sessionId?: string;
}

/** What a route answers. */
export interface AgentRaiseAnswer {
  status: 403 | 428 | 429 | 503;
  body: Record<string, unknown>;
}

interface PendingRaise {
  readonly approvalId: string;
  readonly agentPath: string;
  readonly agentName: string;
  readonly sessionId?: string;
  readonly kind: string;
  readonly target: string;
  readonly inputHash: string;
  readonly expiresAt: number;
  readonly run: AgentRaiseWrite['run'];
  readonly timer: ReturnType<typeof setTimeout>;
}

let approvalService: Pick<ApprovalService, 'request' | 'deny' | 'withdrawGranted'> | undefined;
const pending = new Map<string, PendingRaise>();

/**
 * Wire the approval store the cards are raised in. Called once at boot.
 *
 * @param approvals - The approval service.
 */
export function initAgentRaiseCards(
  approvals: Pick<ApprovalService, 'request' | 'deny' | 'withdrawGranted'>
): void {
  approvalService = approvals;
}

/** Forget every waiting card and the store (tests only). */
export function resetAgentRaiseCardsForTests(): void {
  for (const raise of pending.values()) clearTimeout(raise.timer);
  pending.clear();
  approvalService = undefined;
}

/**
 * Whether an approval is an agent-raise card.
 *
 * @param capabilityId - The approval's capability id.
 */
export function isAgentRaiseCard(capabilityId: string | undefined): boolean {
  return capabilityId?.startsWith(AGENT_RAISE_PREFIX) === true;
}

/** Whether the agent's turn read words from outside the team. */
function turnMarked(agentPath: string, sessionId?: string): boolean {
  return marksHold(marksOf(sessionId, agentPath)) || chatReadOutsideWords(sessionId, agentPath);
}

/** The card's full text: each change, from → to. */
function detailOf(effect: AgentRaiseEffect): string {
  return effect.changes.map((c) => `${c.what}: ${c.from} → ${c.to}`).join('\n');
}

/** Turn a waiting card down and forget it. */
function retire(raise: PendingRaise, reason: string): void {
  clearTimeout(raise.timer);
  pending.delete(raise.approvalId);
  approvalService?.deny(raise.approvalId, reason);
}

/**
 * Put an agent's raise on a card, or refuse it.
 *
 * @param caller - Who asked.
 * @param write - The raise, its effect and its stored write.
 * @returns The 428 with only the card id and its request code, or the refusal.
 */
export function raiseAgentCard(caller: AgentRaiseCaller, write: AgentRaiseWrite): AgentRaiseAnswer {
  const identity = caller.identity && !caller.identity.inactive ? caller.identity : undefined;
  if (!identity) {
    return {
      status: 403,
      body: {
        error: "DorkOS couldn't tell which agent asked, so nobody was asked.",
        code: 'agent_raise_unidentified',
      },
    };
  }
  if (turnMarked(identity.agentPath, caller.sessionId)) {
    return {
      status: 403,
      body: {
        error:
          'This turn read words from outside your team, so DorkOS changed nothing and asked nobody.',
        code: 'agent_raise_marked',
      },
    };
  }
  if (!approvalService) {
    return {
      status: 503,
      body: { error: 'DorkOS can’t raise a card right now.', code: 'agent_raise_unavailable' },
    };
  }
  const mine = [...pending.values()].filter((p) => p.agentPath === identity.agentPath);
  // A newer ask for the same thing replaces the older card.
  for (const older of mine.filter((p) => p.target === write.target && p.kind === write.kind)) {
    retire(older, 'The agent asked again; the newer card replaces this one.');
  }
  const waiting = [...pending.values()].filter((p) => p.agentPath === identity.agentPath).length;
  if (waiting >= MAX_PENDING_PER_AGENT) {
    return {
      status: 429,
      body: {
        error: `This agent already has ${MAX_PENDING_PER_AGENT} cards waiting. Wait for an answer first.`,
        code: 'agent_raise_cap',
      },
    };
  }
  const inputHash = hashApprovalInput({
    kind: write.kind,
    target: write.target,
    input: write.input,
  });
  const ticket = approvalService.request({
    capabilityId: `${AGENT_RAISE_PREFIX}${write.kind}`,
    inputHash,
    summary: write.effect.summary,
    detail: detailOf(write.effect),
    requestedBy: identity.displayName,
    requestedByPath: identity.agentPath,
    area: null,
    raisesPermissions: true,
    ...(caller.sessionId ? { requestingSession: { sessionId: caller.sessionId } } : {}),
  });
  const expiresAt = Date.now() + AGENT_RAISE_TTL_MS;
  const timer = setTimeout(() => {
    const raise = pending.get(ticket.approvalId);
    if (raise) retire(raise, 'Nobody answered in time. The agent has to ask again.');
  }, AGENT_RAISE_TTL_MS);
  timer.unref?.();
  pending.set(ticket.approvalId, {
    approvalId: ticket.approvalId,
    agentPath: identity.agentPath,
    agentName: identity.displayName,
    ...(caller.sessionId ? { sessionId: caller.sessionId } : {}),
    kind: write.kind,
    target: write.target,
    inputHash,
    expiresAt,
    run: write.run,
    timer,
  });
  // Only the card id and its request code: no token, no link (Security condition 6).
  return {
    status: 428,
    body: {
      error: 'This needs a person’s yes. DorkOS put it on a card for them.',
      code: 'agent_raise_card',
      approvalId: ticket.approvalId,
      ...(ticket.requestCode ? { requestCode: ticket.requestCode } : {}),
    },
  };
}

/** Why a card can't be answered yes, in the words the person reads. */
export type AgentRaiseRefusal = { status: 409; body: { error: string; code: string } };

/**
 * Check a card before the person's yes is recorded: it still waits, it hasn't
 * expired, and the agent's turn hasn't been marked since. A card that fails is
 * turned down, so the agent has to ask again.
 *
 * @param approvalId - The card.
 * @returns The refusal, or `undefined` when the yes may go ahead.
 */
export function refuseAgentRaiseYes(approvalId: string): AgentRaiseRefusal | undefined {
  const raise = pending.get(approvalId);
  const askAgain = (error: string, code: string): AgentRaiseRefusal => ({
    status: 409,
    body: { error, code },
  });
  if (!raise) {
    return askAgain(
      'This card can no longer be answered. Ask the agent to ask again.',
      'agent_raise_gone'
    );
  }
  if (Date.now() >= raise.expiresAt) {
    retire(raise, 'Nobody answered in time. The agent has to ask again.');
    return askAgain('This card expired. Ask the agent to ask again.', 'agent_raise_expired');
  }
  if (turnMarked(raise.agentPath, raise.sessionId)) {
    retire(raise, 'The agent’s turn read words from outside your team since it asked.');
    return askAgain(
      'The agent read words from outside your team since it asked, so this card no longer counts.',
      'agent_raise_marked'
    );
  }
  return undefined;
}

/**
 * Run a card's stored write once, after the person's yes was recorded, and spend
 * the yes so it can't be used again.
 *
 * @param approvalId - The card the person said yes to.
 * @param approvedBy - The person, as the audit trail names them.
 * @returns The write's own answer, or a 409 when the card is gone.
 */
export async function commitAgentRaise(
  approvalId: string,
  approvedBy: string
): Promise<{ status: number; body: unknown }> {
  const raise = pending.get(approvalId);
  if (!raise) {
    return {
      status: 409,
      body: {
        error: 'This card was already used. Ask the agent to ask again.',
        code: 'agent_raise_gone',
      },
    };
  }
  // Single use: forget it before running, so a second yes finds nothing.
  clearTimeout(raise.timer);
  pending.delete(approvalId);
  approvalService?.withdrawGranted(approvalId);
  let result: { status: number; body: unknown };
  try {
    result = await raise.run();
  } catch (err) {
    result = {
      status: 500,
      body: { error: err instanceof Error ? err.message : 'The change failed.' },
    };
  }
  recordAudit({
    action: `${AGENT_RAISE_PREFIX}${raise.kind}`,
    operation: 'modify',
    outcome: result.status < 400 ? 'ok' : 'refused',
    target: { type: 'approval', id: approvalId, name: raise.target },
    change: [
      { field: 'requestedBy', after: raise.agentName },
      { field: 'requestedByPath', after: raise.agentPath },
      { field: 'approvedBy', after: approvedBy },
      { field: 'inputHash', after: raise.inputHash },
    ],
    summary: `Requested by ${raise.agentName}, approved by ${approvedBy} (card ${approvalId})`,
    ...(result.status < 400 ? {} : { error: `The write answered ${result.status}.` }),
  });
  return result;
}

/**
 * Forget a card the person turned down.
 *
 * @param approvalId - The card.
 */
export function discardAgentRaise(approvalId: string): void {
  const raise = pending.get(approvalId);
  if (!raise) return;
  clearTimeout(raise.timer);
  pending.delete(approvalId);
}

/**
 * The person's yes on an agent-raise card: check the card, record the yes, then
 * run the stored write once. Always allow is never offered on these cards (they
 * carry no area and a full detail), so the grant route refuses it before this.
 *
 * @param approvalId - The card.
 * @param approvedBy - The person, as the audit trail names them.
 * @param grant - Records the yes; answers why it failed, or `undefined`.
 * @returns The answer to send, or the failure the grant route words itself.
 */
export async function grantAgentRaise<F extends string>(
  approvalId: string,
  approvedBy: string,
  grant: () => F | undefined
): Promise<{ status: number; body: unknown } | { failure: F }> {
  const refused = refuseAgentRaiseYes(approvalId);
  if (refused) return refused;
  const failure = grant();
  if (failure) return { failure };
  const result = await commitAgentRaise(approvalId, approvedBy);
  if (result.status >= 400) return result;
  return {
    status: 200,
    body: { ok: true, approvalId, outcome: 'granted', answer: 'once', result: result.body },
  };
}

/** The card title for each kind of raise an agent can ask for on a card. */
const AGENT_RAISE_TITLES: Record<string, string> = {
  'relay.allowlist': 'Let someone reach your agents',
  'relay.binding': 'Let a chat connection do more',
};

/**
 * The card's title and tier for an agent-raise card, which is not a capability
 * anyone invokes, so the registry doesn't know it.
 *
 * @param capabilityId - The approval's capability id.
 */
export function describeAgentRaiseCapability(
  capabilityId: string
): { title: string; tier: 'act' } | undefined {
  if (!isAgentRaiseCard(capabilityId)) return undefined;
  const kind = capabilityId.slice(AGENT_RAISE_PREFIX.length);
  return { title: AGENT_RAISE_TITLES[kind] ?? 'Let an agent do more', tier: 'act' };
}
