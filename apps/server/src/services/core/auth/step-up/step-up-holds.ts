/**
 * The actions waiting on a "Confirm it's you" step-up (DOR-3234), and the
 * statement each is bound to.
 *
 * A guarded route never runs its action on the first ask. It holds it here,
 * with the one function that commits it, and answers with the held action's
 * id. The person then confirms that id, and only that id: the action, its
 * hash and the sentence the sheet shows were all fixed by the server when it
 * held it. Nothing the app sends afterwards can change what runs.
 *
 * - **Bound to one action.** The statement carries the action's kind, its
 *   target and a canonical hash of its input, with a fresh nonce.
 * - **Short-lived.** {@link STEP_UP_TTL_MS}, then it is gone.
 * - **Single use.** {@link takeHeldStepUp} removes it before it commits, so
 *   it can never run twice.
 * - **Bound to the browser that asked.** It records the session that held
 *   it, and the routes refuse any other.
 * - **In memory.** A restart drops every held action, which the sheet reads
 *   as "That took too long. Nothing changed."
 *
 * The statement is a separate type from the relay's approval statement
 * (`@dork-labs/cloud-api`), and {@link parseLocalStepUpStatement} refuses
 * anything else, so a statement made for one can never pass for the other.
 *
 * @module services/core/auth/step-up/step-up-holds
 */
import { randomBytes } from 'node:crypto';
import { ulid } from 'ulidx';

import {
  LOCAL_STEP_UP_STATEMENT_TYPE,
  LocalStepUpStatementV1Schema,
  STEP_UP_MAX_PASSWORD_TRIES,
  STEP_UP_TTL_MS,
  type LocalStepUpStatementV1,
  type StepUpActionKind,
} from '@dorkos/shared/step-up';

import type { RequestFacts } from '../../../../http/request-facts.js';
import { hashApprovalInput } from '../../approvals/approval-input-hash.js';

/** The most actions held at once; past it the oldest is dropped. */
export const MAX_HELD_STEP_UPS = 16;

/** What committing a held action answered: its own status and body. */
export interface StepUpCommitResult {
  status: number;
  body: unknown;
}

/** What a guarded route holds. */
export interface StepUpActionInput {
  kind: StepUpActionKind;
  /** What it acts on, in the server's words. */
  target: string;
  /** Exactly what will run, as plain JSON; its hash binds the statement. */
  input: unknown;
  /** The sheet's sentence, built by the server from `input`, never from a name an agent chose alone. */
  reason: string;
  /** Quiet extra lines for the sheet. */
  notes?: readonly string[];
  /**
   * Run the action. Called once, only after a step-up passed, never with the
   * request that held it in scope: it must re-check anything that may have
   * changed in the meantime, its own person bar included, and answer the way
   * the route would have.
   *
   * @param confirming - The request that confirmed it: the same browser
   *   session, already checked to be a person in this server's own page.
   */
  commit: (confirming: RequestFacts) => Promise<StepUpCommitResult>;
}

/** One held action. */
export interface HeldStepUp {
  statement: LocalStepUpStatementV1;
  reason: string;
  notes: readonly string[];
  /** The browser session that held it, or `null` when the caller had none. */
  sessionId: string | null;
  commit: StepUpActionInput['commit'];
  /** Wrong passwords it will still take. */
  triesLeft: number;
}

/** By held-action id, oldest first. */
const held = new Map<string, HeldStepUp>();

/**
 * The canonical hash of one action: its kind, target and input, through the
 * same canonical JSON hash approvals are bound with.
 *
 * @param action - The action's kind, target and input.
 * @throws ApprovalInputNotBindableError when the input is not plain JSON.
 */
export function stepUpActionHash(
  action: Pick<StepUpActionInput, 'kind' | 'target' | 'input'>
): string {
  return hashApprovalInput({
    t: LOCAL_STEP_UP_STATEMENT_TYPE,
    kind: action.kind,
    target: action.target,
    input: action.input,
  });
}

/** Drop what expired, and the live one this same browser held for the same action. */
function prune(now: number, sessionId: string | null, kind: string, inputSha256: string): void {
  for (const [id, entry] of held) {
    const { statement } = entry;
    const sameAction =
      entry.sessionId === sessionId &&
      statement.kind === kind &&
      statement.inputSha256 === inputSha256;
    if (sameAction || now >= Date.parse(statement.expiresAt)) held.delete(id);
  }
}

/**
 * Hold an action until a step-up passes. Holding the same action again from
 * the same browser replaces the one before.
 *
 * @param action - What to hold. See {@link StepUpActionInput}.
 * @param sessionId - The browser session asking, or `null`.
 * @param now - The current time, for tests.
 * @returns The statement it is bound to.
 * @throws ApprovalInputNotBindableError when the input is not plain JSON, so
 *   nothing is held that its hash would not really bind.
 */
export function holdStepUp(
  action: StepUpActionInput,
  sessionId: string | null,
  now = Date.now()
): LocalStepUpStatementV1 {
  const inputSha256 = stepUpActionHash(action);
  prune(now, sessionId, action.kind, inputSha256);
  while (held.size >= MAX_HELD_STEP_UPS) {
    const oldest = held.keys().next().value;
    if (oldest === undefined) break;
    held.delete(oldest);
  }
  const statement: LocalStepUpStatementV1 = {
    t: LOCAL_STEP_UP_STATEMENT_TYPE,
    purpose: 'step-up',
    heldActionId: ulid(),
    kind: action.kind,
    target: action.target,
    inputSha256,
    nonce: randomBytes(32).toString('base64url'),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + STEP_UP_TTL_MS).toISOString(),
  };
  held.set(statement.heldActionId, {
    statement,
    reason: action.reason,
    notes: action.notes ?? [],
    sessionId,
    commit: action.commit,
    triesLeft: STEP_UP_MAX_PASSWORD_TRIES,
  });
  return statement;
}

/**
 * A held action, while it is still live, without using it.
 *
 * @param heldActionId - Its id.
 * @param now - The current time, for tests.
 */
export function peekHeldStepUp(heldActionId: string, now = Date.now()): HeldStepUp | undefined {
  const entry = held.get(heldActionId);
  if (!entry) return undefined;
  if (now >= Date.parse(entry.statement.expiresAt)) {
    held.delete(heldActionId);
    return undefined;
  }
  return entry;
}

/**
 * Take a held action out to commit it: after this it can never be confirmed
 * again, whatever its commit does.
 *
 * @param heldActionId - Its id.
 * @param now - The current time, for tests.
 */
export function takeHeldStepUp(heldActionId: string, now = Date.now()): HeldStepUp | undefined {
  const entry = peekHeldStepUp(heldActionId, now);
  held.delete(heldActionId);
  return entry;
}

/**
 * Count one wrong password against a held action, dropping it on the last.
 *
 * @param heldActionId - Its id.
 * @returns The wrong passwords it will still take; `0` means it is gone.
 */
export function spendStepUpTry(heldActionId: string): number {
  const entry = held.get(heldActionId);
  if (!entry) return 0;
  entry.triesLeft -= 1;
  if (entry.triesLeft <= 0) held.delete(heldActionId);
  return Math.max(0, entry.triesLeft);
}

/**
 * Drop a held action without running it: a cancel.
 *
 * @param heldActionId - Its id.
 */
export function cancelHeldStepUp(heldActionId: string): void {
  held.delete(heldActionId);
}

/**
 * A local step-up statement, or `null` for anything else, the relay's
 * approval statement included.
 *
 * @param value - What claims to be one.
 */
export function parseLocalStepUpStatement(value: unknown): LocalStepUpStatementV1 | null {
  const parsed = LocalStepUpStatementV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Forget every held action.
 *
 * @internal Tests only.
 */
export function resetHeldStepUpsForTests(): void {
  held.clear();
}
