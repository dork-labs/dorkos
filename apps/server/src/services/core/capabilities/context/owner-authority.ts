/**
 * The owner a capability behind the account-decision bar acts for
 * (`http.ownerBar: 'account-decision'`, DOR-4978), and the one way it reaches
 * the handler.
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
 * Never read from the input, a header or a door's own context: the pass is an
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
     * capability that declares `http.ownerBar`.
     */
    accountDecision?: AccountDecisionPass;
  }
  interface CapabilityHandlerContext {
    /**
     * Set by the registry, never by a caller: the server-owned owner the
     * account-decision bar resolved, frozen, and only on a capability that
     * declares `http.ownerBar`. `undefined` on every other capability.
     */
    readonly ownerAuthority?: Readonly<ConnectorOwnerAuthority>;
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
  if (capability.surfaces.http?.ownerBar === undefined) return undefined;
  if (pass instanceof AccountDecisionPassMarker) return pass.ownerAuthority;
  throw new CapabilityToolError({ error: PERSON_ONLY_MESSAGE, code: PERSON_ONLY_CODE });
}
