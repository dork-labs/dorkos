/**
 * What a capability handler may learn about the HTTP request it was called on
 * (DOR-4978, ADR 261125-114705 decision 2).
 *
 * @module services/core/capabilities/context/request-facts
 */

/**
 * A few answers the server worked out from the request, never the request
 * itself. A handler never sees a header, so a session cookie, an API key or an
 * `Authorization` value cannot reach it, its logs or its answer. Worked out by
 * `capabilityRequestFacts` (`routes/capability-dispatch.ts`).
 */
export interface CapabilityRequestFacts {
  /**
   * Whether the caller clears the account owner bar: a person, never an
   * agent, and with a person's session required, the install's owner
   * (`refuseUnlessAccountOwner`).
   */
  readonly accountOwner: boolean;
  /**
   * Whether the request proves the owner in person: their own session
   * cookie, and not a Wi-Fi request the Wi-Fi hold holds (`personProof`).
   */
  readonly ownerProven: boolean;
  /**
   * Whether the request comes from this computer (`isAtThisComputer`) and
   * carries no program credential (a key, token or bearer).
   */
  readonly atThisComputerWithoutProgramKey: boolean;
  /**
   * Whether the request is the owner's own sign-in on a Wi-Fi device the
   * Wi-Fi hold holds (`heldWifiOwner`, DOR-5070): it never proves the owner,
   * and a `person-held` capability gives it no more than its no-owner
   * allowance (ADR 261125-114705, decision 3).
   */
  readonly heldWifiOwner: boolean;
}
