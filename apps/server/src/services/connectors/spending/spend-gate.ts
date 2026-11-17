/**
 * The monthly spend limit on the connector execution path (DOR-4204 PR 2):
 * what a paid run's preflight tells the permission gate, and the reserve the
 * broker makes before the provider is called.
 *
 * The preflight answer decides whether a card is raised. The reserve is the
 * enforcement: it re-reads the meter and writes the run in one synchronous
 * transaction, so a run that slipped past the preflight (two side by side, a
 * limit lowered while a card was open) is still refused before it spends
 * (Security Must 3, spec §4.4).
 *
 * A person running an action from their own app is not an agent spending;
 * neither the preflight nor the reserve applies to them.
 *
 * @module services/connectors/spending/spend-gate
 */
import { isPaidOperation } from '@dorkos/shared/connector-schemas';
import type { GrantedApproval } from '../../core/capabilities/tier-enforcement.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import type { SpendPreflight } from '../../core/capabilities/spend-permission.js';
import { notify } from '../../notifications/notification-service.js';
import { connectorSpending, spendFactsFor, wasSpendCard } from './spending-port.js';
import { spendingNoticesAfter, type SpendingNotice } from './spending-notices.js';
import { monthOf, nextMonthStart } from './spending-store.js';
import { decideSpend, spendPreflightOf, type SpendFacts } from './spend-decision.js';
import {
  EXTENSION_SPEND_COPY,
  SPEND_APPROVAL_REQUIRED,
  SPEND_COPY,
  SPEND_LIMIT,
  SPEND_OUTSIDER,
  limitRefusal,
  money,
} from './spend-copy.js';

/** The parts of an authorized connector call the spend limit reads. */
export interface SpendSubject {
  readonly actorKind: 'operator' | 'agent' | 'program' | 'runtime';
  readonly agentId: string;
  readonly sessionId?: string;
  readonly operation: { readonly toolkit: string; readonly operationSlug: string };
  /** The app and action in plain words, for the Activity line. */
  readonly serviceAction?: { readonly serviceName: string; readonly actionName: string };
}

/** One Activity line about a paid run (spec §9). */
function record(
  subject: SpendSubject,
  eventType: 'spending.ran' | 'spending.refused',
  line: (agent: string, action: string) => string
): void {
  const port = connectorSpending();
  if (!port?.activity) return;
  const agent = port.agentName?.(subject.agentId) ?? 'An agent';
  const action = subject.serviceAction
    ? `${subject.serviceAction.serviceName}: ${subject.serviceAction.actionName}`
    : subject.operation.toolkit;
  void port.activity.emit({
    actorType: 'agent',
    actorId: subject.agentId,
    actorLabel: agent,
    category: 'agent',
    eventType,
    resourceType: 'connector',
    resourceLabel: subject.operation.toolkit,
    summary: line(agent, action),
  });
}

/** The Activity line for a paid run refused on an outsider-marked turn. */
function recordOutsider(subject: SpendSubject): void {
  record(
    subject,
    'spending.refused',
    (agent) => `${agent}'s paid run was refused: the turn read outside content.`
  );
}

/** The Activity line for a paid run refused at the limit. */
function recordLimit(subject: SpendSubject): void {
  record(
    subject,
    'spending.refused',
    (agent, action) => `Refused ${agent}: ${action} · monthly limit reached`
  );
}

/** A paid run refused at the limit: recorded, then thrown. */
function refuseAtLimit(subject: SpendSubject, message: string): never {
  recordLimit(subject);
  throw new CapabilityToolError({ error: message, code: SPEND_LIMIT });
}

/**
 * The preflight's spend answer for one authorized call, or `undefined` when it
 * is free, run by a person, or the spend limit is not wired.
 *
 * @param subject - The call the authorization service just prepared.
 * @param now - The decision's instant.
 */
export function spendPreflightFor(
  subject: SpendSubject,
  now: Date = new Date()
): SpendPreflight | undefined {
  const port = connectorSpending();
  if (!port || subject.actorKind === 'operator') return undefined;
  const spend = spendPreflightOf(spendFactsFor(port, subject.operation, subject, now));
  if (spend?.kind !== 'refuse') return spend;
  // The gate refuses before the broker's reserve runs, so it writes the line.
  const line = spend.code === SPEND_OUTSIDER ? recordOutsider : recordLimit;
  return { ...spend, record: () => line(subject) };
}

/**
 * Reserve one paid run before the provider is called, or refuse it. Only the
 * first attempt reserves; a retry runs on the same reservation.
 *
 * @param subject - The call about to run.
 * @param runId - The broker's logical operation id: the reservation's key.
 * @param approval - How the gate let the call through; `approval` is a person's Allow once.
 * @param now - The decision's instant.
 * @returns The reservation id when one was written, so a run that never
 *   started can give it back.
 * @throws {CapabilityToolError} When the run may not spend.
 */
export function reserveSpend(
  subject: SpendSubject,
  runId: string,
  approval: GrantedApproval | undefined,
  now: Date = new Date()
): string | undefined {
  const port = connectorSpending();
  if (!port || subject.actorKind === 'operator') return undefined;
  const facts = spendFactsFor(port, subject.operation, subject, now);
  if (!facts.paid) return undefined;
  if (facts.outsider) {
    recordOutsider(subject);
    throw new CapabilityToolError({ error: SPEND_COPY.outsider, code: SPEND_OUTSIDER });
  }
  // Only a yes on a paid-run card is the owner's yes to spend: a yes on an
  // ordinary card may come from someone else, for another reason (Must 2).
  const allowedOnce = approval?.via === 'approval' && wasSpendCard(approval.approvalId);
  const decision = decideSpend(facts);
  if (!allowedOnce) {
    // Only a quiet run reaches here without a person's yes.
    if (decision.kind === 'refuse') refuseAtLimit(subject, decision.message);
    if (decision.kind !== 'run') {
      throw new CapabilityToolError({
        error: facts.usedMicro === 'unreadable' ? SPEND_COPY.unreadable : SPEND_COPY.needsYes,
        code: SPEND_APPROVAL_REQUIRED,
      });
    }
  }
  // A person said yes to this one run with the meter unreadable: it runs,
  // and is counted if the meter can be written at all.
  const enforceLimit = facts.limitMicro !== null;
  let result;
  try {
    result = port.store.reserve({
      id: runId,
      toolkit: subject.operation.toolkit,
      agentId: subject.agentId,
      amountMicro: facts.priceMicro,
      source: 'person',
      enforceLimit,
    });
  } catch (error) {
    if (allowedOnce && facts.usedMicro === 'unreadable') return undefined;
    throw error;
  }
  if (!result.ok) {
    refuseAtLimit(subject, limitRefusal(result.reason, result.leftMicro, facts.resetsAt ?? now));
  }
  const price = facts.priceMicro === null ? 'price unknown' : `about ${money(facts.priceMicro)}`;
  const after =
    typeof facts.usedMicro === 'number' ? facts.usedMicro + (facts.priceMicro ?? 0) : null;
  record(subject, 'spending.ran', (agent, action) =>
    allowedOnce || facts.limitMicro === null || after === null
      ? `${agent} ran ${action} · allowed once · ${price}`
      : `${agent} ran ${action} · ${price} · ${money(Math.max(0, facts.limitMicro - after))} left`
  );
  if (typeof facts.usedMicro === 'number') {
    raiseNotices(
      spendingNoticesAfter({
        beforeMicro: facts.usedMicro,
        afterMicro: facts.usedMicro + (facts.priceMicro ?? 0),
        limitMicro: facts.limitMicro,
        month: monthOf(now),
        resetsAt: facts.resetsAt ?? now,
      })
    );
  } else {
    raiseNotices([{ kind: 'spending.meter-reset', payload: { month: monthOf(now) } }]);
  }
  return runId;
}

/** The parts of a mini app's read the spend limit reads (DOR-4575). */
export interface ExtensionSpendSubject {
  readonly extensionId: string;
  readonly operation: { readonly toolkit: string; readonly operationSlug: string };
}

/** What {@link reserveExtensionSpend} answers. */
export type ExtensionSpendResult =
  | { readonly ok: true; readonly reservation?: string }
  | { readonly ok: false; readonly message: string };

/** One Activity line about a mini app's paid read. */
function recordExtension(
  subject: ExtensionSpendSubject,
  eventType: 'spending.ran' | 'spending.refused',
  summary: string
): void {
  void connectorSpending()?.activity?.emit({
    actorType: 'system',
    actorId: subject.extensionId,
    actorLabel: `Mini app ${subject.extensionId}`,
    category: 'agent',
    eventType,
    resourceType: 'connector',
    resourceLabel: subject.operation.toolkit,
    summary,
  });
}

/**
 * Reserve a mini app's paid read before the provider is called, or refuse it
 * (DOR-4575). The same meter and the same one-transaction reserve as an
 * agent's paid run, so the two together never pass the limit. A mini app
 * can't answer a card, so every case that would ask a person is refused:
 * no limit set, no price for the app, a meter that can't be read, or the
 * spend limit not wired at all.
 *
 * @param subject - The mini app and the read about to run.
 * @param runId - The read's logical operation id: the reservation's key.
 * @param now - The decision's instant.
 * @returns The reservation when one was written, or why the read may not run.
 */
export function reserveExtensionSpend(
  subject: ExtensionSpendSubject,
  runId: string,
  now: Date = new Date()
): ExtensionSpendResult {
  if (!isPaidOperation(subject.operation)) return { ok: true };
  const refuse = (message: string): ExtensionSpendResult => {
    recordExtension(
      subject,
      'spending.refused',
      `Refused mini app ${subject.extensionId}: ${subject.operation.toolkit} · paid read`
    );
    return { ok: false, message };
  };
  const port = connectorSpending();
  if (!port) return refuse(EXTENSION_SPEND_COPY.unreadable);
  const resetsAt = nextMonthStart(now);
  let facts: SpendFacts;
  try {
    facts = {
      paid: true,
      // A mini app runs no turn, so no turn of it read outside words.
      outsider: false,
      limitMicro: port.store.limit(),
      priceMicro: port.store.price(subject.operation.toolkit),
      usedMicro: port.store.meter().usedMicro,
      resetsAt,
    };
  } catch {
    return refuse(EXTENSION_SPEND_COPY.unreadable);
  }
  const decision = decideSpend(facts);
  if (decision.kind === 'refuse') return refuse(decision.message);
  if (decision.kind === 'ask') {
    return refuse(
      decision.reason === 'no-limit'
        ? EXTENSION_SPEND_COPY.noLimit
        : decision.reason === 'unknown-price'
          ? EXTENSION_SPEND_COPY.unknownPrice
          : EXTENSION_SPEND_COPY.unreadable
    );
  }
  // `paid` is set above, so `free` can't come back; money fails closed anyway.
  if (decision.kind !== 'run') return refuse(EXTENSION_SPEND_COPY.unreadable);
  let result;
  try {
    result = port.store.reserve({
      id: runId,
      toolkit: subject.operation.toolkit,
      agentId: `extension:${subject.extensionId}`,
      amountMicro: decision.priceMicro,
      source: 'person',
      enforceLimit: true,
    });
  } catch {
    return refuse(EXTENSION_SPEND_COPY.unreadable);
  }
  if (!result.ok) return refuse(limitRefusal(result.reason, result.leftMicro, resetsAt));
  const usedMicro = facts.usedMicro as number;
  const afterMicro = usedMicro + decision.priceMicro;
  recordExtension(
    subject,
    'spending.ran',
    `Mini app ${subject.extensionId} ran ${subject.operation.toolkit} · about ${money(decision.priceMicro)} · ${money(Math.max(0, (facts.limitMicro ?? 0) - afterMicro))} left`
  );
  raiseNotices(
    spendingNoticesAfter({
      beforeMicro: usedMicro,
      afterMicro,
      limitMicro: facts.limitMicro,
      month: monthOf(now),
      resetsAt,
    })
  );
  return { ok: true, reservation: runId };
}

/** Raise notices without ever failing the run that crossed them. */
function raiseNotices(
  notices: readonly (
    SpendingNotice | { kind: 'spending.meter-reset'; payload: { month: string } }
  )[]
): void {
  for (const notice of notices) {
    const send = connectorSpending()?.notify ?? notify;
    void send(notice.kind, notice.payload as never).catch(() => {
      // A notice that could not be raised changes nothing about the run.
    });
  }
}

/**
 * Give a reserved run back when it never reached the provider.
 *
 * @param runId - The reservation from {@link reserveSpend}.
 */
export function releaseSpend(runId: string | undefined): void {
  if (runId === undefined) return;
  try {
    connectorSpending()?.store.release(runId);
  } catch {
    // The meter keeps the run counted; stricter, never looser.
  }
}

/**
 * The receipt for a paid-run card tapped Allow once after the limit stopped
 * fitting it (spec §4.4), or `null` when it still fits or no limit is set.
 * The broker's reserve re-checks it anyway; this only answers the tap honestly.
 *
 * @param serviceAction - The card's app and action, as stored with it.
 */
export function spendTapRefusal(
  serviceAction: { serviceId: string; spend?: unknown } | undefined
): string | null {
  const port = connectorSpending();
  if (!port || !serviceAction?.spend) return null;
  try {
    const limitMicro = port.store.limit();
    if (limitMicro === null) return null;
    const usedMicro = port.store.meter().usedMicro;
    const priceMicro = port.store.price(serviceAction.serviceId) ?? 0;
    return usedMicro >= limitMicro || usedMicro + priceMicro > limitMicro
      ? SPEND_COPY.limitReceipt
      : null;
  } catch {
    // An unreadable meter fails into cards, and this is the person's yes.
    return null;
  }
}
