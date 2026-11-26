/**
 * What a capability behind a caller bar (`http.callerBar`, DOR-4978) gets from
 * the mount's proof that the bar passed, and the one way it reaches the handler.
 *
 * ## `account-decision`: the owner
 *
 * The owner a capability behind the account-decision bar acts for:
 *
 * The HTTP mount runs the bar (`lib/http/account-decision-bar.ts`) before the
 * handler, on the capability's REST path and on `/invoke` alike, and only when
 * it passes mints an {@link AccountDecisionPass} carrying the server-owned
 * owner. The registry hands that owner to the handler as
 * `context.ownerAuthority`, frozen, and only for a capability that declares
 * the bar. A capability that declares it and arrives without a pass (an
 * in-process call, the CLI, the request tool) is refused `person_only` before
 * anything runs: the bar fails closed below the mount.
 *
 * ## `person`: the person bar's own pass
 *
 * For `http.callerBar: 'person'` the mount runs the person bar
 * (`lib/http/person-bar.ts`) instead of the audience's `personCaller`, and on
 * a pass mints a {@link PersonBarPass}: its own type, never a `PersonCaller`,
 * so a caller it let through (with login off, a program holding a key) is never
 * given a person's authority. It says only who the bar saw: `person` (no program
 * credential) or `program` (a key, which the audit and the feed name as a
 * program). The registry hands it to the handler as `context.personBar`,
 * frozen, and refuses such a capability without one, as it does the owner bar.
 *
 * Never read from the input, a header or a door's own context: each pass is an
 * instance of a class this module keeps, so a look-alike object is not one.
 * Only `routes/capability-dispatch.ts` mints one (pinned by a test).
 *
 * @module services/core/capabilities/context/owner-authority
 */
import { PERSON_ONLY_CODE, PERSON_ONLY_MESSAGE } from '@dorkos/shared/capabilities';

import type { ConnectorOwnerAuthority } from '../../connections-lease/index.js';
import type { CapabilityDefinition } from '../capability-definition.js';
import { CapabilityToolError } from '../mcp-envelope.js';

declare module '../registry.js' {
  interface CapabilityInvocationContext {
    /**
     * Proof the account-decision bar passed for this request, minted only by
     * the HTTP mount ({@link accountDecisionPassed}). Read only for a
     * capability that declares `http.callerBar: 'account-decision'`.
     */
    accountDecision?: AccountDecisionPass;
    /**
     * Proof the person bar passed for this request, minted only by the HTTP
     * mount ({@link personBarPassed}). Read only for a capability that
     * declares `http.callerBar: 'person'`.
     */
    personBar?: PersonBarPass;
  }
  interface CapabilityHandlerContext {
    /**
     * Set by the registry, never by a caller: the server-owned owner the
     * account-decision bar resolved, frozen, and only on a capability that
     * declares `http.callerBar: 'account-decision'`. `undefined` on every
     * other capability.
     */
    readonly ownerAuthority?: Readonly<ConnectorOwnerAuthority>;
    /**
     * Set by the registry, never by a caller: the person bar's own pass, only
     * on a capability that declares `http.callerBar: 'person'`. Not a person
     * proof: it carries only who the bar saw.
     */
    readonly personBar?: PersonBarPass;
  }
}

/** Proof the account-decision bar passed: the owner it resolved, frozen. */
class AccountDecisionPassMarker {
  readonly ownerAuthority: Readonly<ConnectorOwnerAuthority>;
  constructor(owner: ConnectorOwnerAuthority) {
    this.ownerAuthority = Object.freeze({ ...owner });
    Object.freeze(this);
  }
}

/** An opaque proof the account-decision bar passed. */
export type AccountDecisionPass = AccountDecisionPassMarker;

/**
 * Mint the proof, after the bar passed. Only the HTTP mount calls this.
 *
 * @param owner - The owner the bar resolved from verified server state.
 * @returns The proof, carrying a frozen copy of the owner.
 */
export function accountDecisionPassed(owner: ConnectorOwnerAuthority): AccountDecisionPass {
  return new AccountDecisionPassMarker(owner);
}

/** Who the person bar let through: the app (no program credential) or a program with a key. */
export type PersonBarCaller = 'person' | 'program';

/** Proof the person bar passed: who it saw, frozen. */
class PersonBarPassMarker {
  readonly caller: PersonBarCaller;
  constructor(caller: PersonBarCaller) {
    this.caller = caller;
    Object.freeze(this);
  }
}

/** An opaque proof the person bar passed. Never a person proof. */
export type PersonBarPass = PersonBarPassMarker;

/**
 * Mint the proof, after the person bar passed. Only the HTTP mount calls this.
 *
 * @param caller - Whether the request carried a program credential.
 * @returns The proof.
 */
export function personBarPassed(caller: PersonBarCaller): PersonBarPass {
  return new PersonBarPassMarker(caller);
}

/** What the registry adds to a barred capability's handler context. */
export interface CallerBarContext {
  readonly ownerAuthority?: Readonly<ConnectorOwnerAuthority>;
  readonly personBar?: PersonBarPass;
}

/**
 * The bar's half of the handler context, for a capability behind a caller bar.
 *
 * @param capability - The capability being invoked.
 * @param supplied - The call's proofs, if any.
 * @returns The frozen owner or the person bar's pass; empty for a capability
 *   without a bar.
 * @throws CapabilityToolError `PERSON_ONLY` when the capability declares a bar
 *   and the call carries no genuine proof for it.
 */
export function callerBarContext(
  capability: Pick<CapabilityDefinition, 'surfaces'>,
  supplied: { readonly accountDecision?: unknown; readonly personBar?: unknown }
): CallerBarContext {
  const bar = capability.surfaces.http?.callerBar;
  if (bar === undefined) return {};
  if (bar === 'person') {
    if (supplied.personBar instanceof PersonBarPassMarker) return { personBar: supplied.personBar };
    throw new CapabilityToolError({ error: PERSON_ONLY_MESSAGE, code: PERSON_ONLY_CODE });
  }
  return { ownerAuthority: ownerAuthorityFor(capability, supplied.accountDecision)! };
}

/**
 * The owner to hand the handler, for a capability behind the bar.
 *
 * @param capability - The capability being invoked.
 * @param pass - The call's proof, if any.
 * @returns The frozen owner, or `undefined` for a capability without the bar.
 * @throws CapabilityToolError `PERSON_ONLY` when the capability declares the
 *   bar and the call carries no genuine proof.
 */
export function ownerAuthorityFor(
  capability: Pick<CapabilityDefinition, 'surfaces'>,
  pass: unknown
): Readonly<ConnectorOwnerAuthority> | undefined {
  if (capability.surfaces.http?.callerBar !== 'account-decision') return undefined;
  if (pass instanceof AccountDecisionPassMarker) return pass.ownerAuthority;
  throw new CapabilityToolError({ error: PERSON_ONLY_MESSAGE, code: PERSON_ONLY_CODE });
}
