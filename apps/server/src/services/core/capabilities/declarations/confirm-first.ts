/**
 * A confirm-first hold on a capability (ADR 261125-114705, decision 4): an
 * action that runs only after the person confirms it's them, on the existing
 * "Confirm it's you" sheet (`routes/step-up-guard.ts`, `routes/step-up.ts`).
 *
 * The capability declares the hold ({@link CapabilityConfirmFirst}) with its
 * bar ({@link ConfirmFirstBar}); the registry enforces it. A call whose input the hold covers runs only with a
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
import { sealHeldState } from './held-state.js';
import type { CapabilityDeps } from '../capability-definition.js';
import { CapabilityToolError } from '../mcp-envelope.js';
import type { CapabilityHandlerContext } from '../registry.js';

declare module '../registry.js' {
  interface CapabilityHandlerContext {
    /**
     * Set by the registry, never by a caller: for a confirmed `front-door`
     * call, the server state its sheet was built from
     * ({@link ConfirmFirstSheet.heldState}), so the write refuses a change made
     * while the sheet was up instead of undoing it.
     */
    heldState?: string;
  }
}

/**
 * The bar a confirm-first capability runs, on the request that asks AND on the
 * request that confirms, each on its own. Declared in the definition, so it is
 * never chosen from the input or the request (DOR-4978, Security t1j).
 *
 * - `account-owner`: the DorkOS account owner (`refuseUnlessAccountOwner`), the
 *   bar every account write runs, plus the front-door bar (`runAccountWrite`).
 * - `front-door`: the owner, in person, through this computer's own ingress
 *   (`refuseFrontDoorChange`), the bar for every setting that decides what
 *   code DorkOS runs and which credentials it holds (`runFrontDoorWrite`).
 */
export type ConfirmFirstBar = 'account-owner' | 'front-door';

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
 * What a `front-door` hold shows and binds, built by the server for one call.
 *
 * `reason` goes to the audit log as well as the sheet, so it is built only from
 * server constants and names (a server's name, a package's id): never a
 * credential, a token, a URL with credentials, or the input itself.
 */
export interface ConfirmFirstSheet {
  /** What it acts on, in the server's words. */
  readonly target: string;
  /** The sheet's sentence, which the audit log keeps too. */
  readonly reason: string;
  /** Quiet extra lines for the sheet only, each secret value masked. */
  readonly notes?: readonly string[];
  /** The notes to look at twice. Each one is in `notes` too. */
  readonly warnings?: readonly string[];
  /**
   * What the held action is bound to in place of the input: everything that
   * decides what runs, each secret by name only.
   */
  readonly bound: unknown;
  /**
   * Server state read as the sheet was built (a stored record's fingerprint).
   * The registry seals it ({@link sealHeldState}) before anything is held; the
   * sealed value is bound into the hold and handed back to the handler on
   * confirm as `context.heldState`, so the handler re-reads the state, seals
   * it and refuses a change made while the sheet was up instead of undoing it.
   * It never reaches the caller: not the `428`, not the sheet.
   */
  readonly heldState?: string;
}

/** What every confirm-first declaration carries. */
interface ConfirmFirstCommon<Input> {
  /** The step-up kind the sheet and the record name. */
  readonly kind: StepUpActionKind;
  /** Whether this call is held; absent, every call is. A call it doesn't hold runs at once. */
  readonly when?: (input: Input) => boolean;
}

/**
 * A hold behind the account owner bar. The sheet's words and the held action's
 * identity are fixed by the server here, never by the caller.
 */
export interface AccountOwnerConfirmFirst<Input = unknown> extends ConfirmFirstCommon<Input> {
  readonly bar: 'account-owner';
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
}

/** A hold behind the front-door bar, its sheet built from the call and the server's own state. */
export interface FrontDoorConfirmFirst<Input = unknown> extends ConfirmFirstCommon<Input> {
  readonly bar: 'front-door';
  /** What the front-door bar's refusal names ("Only the owner can change …"), a server constant. */
  readonly subject: string;
  /**
   * Build the sheet for one held call, from its parsed input and what the
   * server holds now. Throw a `CapabilityToolError` to refuse before anything
   * is held: whatever a password could not change.
   */
  readonly sheet: (deps: CapabilityDeps, input: Input) => ConfirmFirstSheet;
}

/**
 * What a confirm-first capability declares: its bar, and what the sheet shows.
 *
 * @template Input - The capability's parsed input.
 */
export type CapabilityConfirmFirst<Input = unknown> =
  AccountOwnerConfirmFirst<Input> | FrontDoorConfirmFirst<Input>;

/** A confirmation minted after a step-up passed: one capability, one input, one use. */
class PersonConfirmation {
  used = false;
  constructor(
    readonly capabilityId: string,
    readonly inputHash: string,
    readonly heldState: string | undefined
  ) {}
}

/**
 * The confirmation the HTTP mount hands the registry when it commits a held
 * call, after the person's password passed in the browser that asked. Only
 * `routes/capability-confirm-first.ts` mints one.
 *
 * @param capabilityId - The capability that was held.
 * @param input - The parsed input that was held.
 * @param heldState - The server state its sheet was built from, if any ({@link ConfirmFirstSheet.heldState}).
 * @returns An opaque, single-use confirmation for exactly that call.
 */
export function personConfirmed(capabilityId: string, input: unknown, heldState?: string): unknown {
  return new PersonConfirmation(capabilityId, hashApprovalInput(input), heldState);
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
    readonly hold: CapabilityConfirmFirst,
    /** For a `front-door` hold, the sheet the server built for this call, its `heldState` sealed. */
    readonly sheet?: ConfirmFirstSheet
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
 * @param deps - The registry's deps, for a `front-door` hold's sheet.
 * @param context - The handler's context: a confirmed call's `heldState` is set on it.
 * @throws ConfirmFirstRequired when the call is held and carries no unspent
 *   confirmation for this capability and this input; or the sheet's own
 *   refusal, before anything is held.
 */
export function requireConfirmation(
  capability: { readonly id: string; readonly confirmFirst?: CapabilityConfirmFirst },
  parsed: unknown,
  confirmed: unknown,
  deps: CapabilityDeps,
  context: CapabilityHandlerContext
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
    if (confirmed.heldState !== undefined) context.heldState = confirmed.heldState;
    return;
  }
  const sheet = hold.bar === 'front-door' ? hold.sheet(deps, parsed) : undefined;
  throw new ConfirmFirstRequired(
    parsed,
    hold,
    sheet?.heldState === undefined ? sheet : { ...sheet, heldState: sealHeldState(sheet.heldState) }
  );
}
