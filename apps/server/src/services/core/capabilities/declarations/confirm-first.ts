/**
 * A confirm-first hold on a capability (ADR 261125-114705, decision 4): an
 * action that runs only after the person confirms it's them, on the existing
 * "Confirm it's you" sheet (`routes/step-up-guard.ts`, `routes/step-up.ts`).
 *
 * The capability declares the hold ({@link CapabilityConfirmFirst}); the
 * registry enforces it. A call whose input the hold covers runs only with a
 * confirmation the HTTP mount minted after the person's password passed
 * ({@link personConfirmed}), for exactly that capability and that input, once.
 * Any other call is refused with {@link ConfirmFirstRequired}: the HTTP mount
 * turns that into the held action and its `428`, and every other door (an
 * in-process call, a re-invocation by the request tool) reads a refusal. So no
 * agent path can satisfy it, and the handler never decides whether it was
 * confirmed.
 *
 * Only the capabilities `CONFIRM_FIRST_CAPABILITY_IDS` lists may declare one
 * (`narrow-declarations.ts`).
 *
 * @module services/core/capabilities/declarations/confirm-first
 */
import type { StepUpActionKind } from '@dorkos/shared/step-up';

import { hashApprovalInput } from '../../approvals/approval-input-hash.js';
import { CapabilityToolError } from '../mcp-envelope.js';

/**
 * The account owner bar a confirm-first capability runs, in its own words: the
 * same bar and sentences every DorkOS account write runs
 * (`routes/cloud-owner-bar.ts`). The mount runs it on every call, held or not,
 * before the input is read, and again on confirmation.
 */
export interface ConfirmFirstOwnerWording {
  /** The whole sentence anything but a person is told. */
  readonly personOnly: string;
  /** What the action does, completing "Only the owner of this DorkOS can …" (no capital, no full stop). */
  readonly action: string;
}

/**
 * What a confirm-first capability declares. The sheet's words and the held
 * action's identity are fixed by the server here, never by the caller.
 *
 * @template Input - The capability's parsed input.
 */
export interface CapabilityConfirmFirst<Input = unknown> {
  /** The step-up kind the sheet and the record name. */
  readonly kind: StepUpActionKind;
  /** What it acts on, in the server's words. */
  readonly target: string;
  /** The sheet's sentence. */
  readonly reason: string;
  /**
   * The account owner bar. Held account writes also re-run it on confirmation
   * and are bound to the account link they were asked against
   * (`runAccountWrite`).
   */
  readonly accountOwner: ConfirmFirstOwnerWording;
  /** Whether this call is held; absent, every call is. A call it doesn't hold runs at once. */
  readonly when?: (input: Input) => boolean;
}

/** A confirmation minted after a step-up passed: one capability, one input, one use. */
class PersonConfirmation {
  used = false;
  constructor(
    readonly capabilityId: string,
    readonly inputHash: string
  ) {}
}

/**
 * The confirmation the HTTP mount hands the registry when it commits a held
 * call, after the person's password passed in the browser that asked. Only
 * `routes/capability-confirm-first.ts` mints one.
 *
 * @param capabilityId - The capability that was held.
 * @param input - The parsed input that was held.
 * @returns An opaque, single-use confirmation for exactly that call.
 */
export function personConfirmed(capabilityId: string, input: unknown): unknown {
  return new PersonConfirmation(capabilityId, hashApprovalInput(input));
}

/**
 * The refusal a confirm-first call gets without a confirmation. The HTTP mount
 * holds it for the sheet; any other caller reads the refusal.
 */
export class ConfirmFirstRequired extends CapabilityToolError {
  constructor(
    /** The parsed input to hold: exactly what will run once confirmed. */
    readonly input: unknown,
    /** The capability's declaration. */
    readonly hold: CapabilityConfirmFirst
  ) {
    super({ code: 'CONFIRM_FIRST', error: 'Confirm this in the DorkOS app first.' });
  }
}

/**
 * Let a call run only once the person confirmed it, when its capability holds
 * it. Spends the confirmation, so it can never run a second call.
 *
 * @param capability - The capability being invoked.
 * @param parsed - Its parsed input, the value that will run.
 * @param confirmed - The confirmation the call carries, if any.
 * @throws ConfirmFirstRequired when the call is held and carries no unspent
 *   confirmation for this capability and this input.
 */
export function requireConfirmation(
  capability: { readonly id: string; readonly confirmFirst?: CapabilityConfirmFirst },
  parsed: unknown,
  confirmed: unknown
): void {
  const hold = capability.confirmFirst;
  if (!hold || (hold.when && !hold.when(parsed))) return;
  if (
    confirmed instanceof PersonConfirmation &&
    !confirmed.used &&
    confirmed.capabilityId === capability.id &&
    confirmed.inputHash === hashApprovalInput(parsed)
  ) {
    confirmed.used = true;
    return;
  }
  throw new ConfirmFirstRequired(parsed, hold);
}
