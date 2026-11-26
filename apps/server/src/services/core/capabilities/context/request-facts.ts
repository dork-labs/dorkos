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
   * Whether the caller clears the agent bar: a person, never an agent or an
   * approval token, and with a person's session required, that session
   * (`clearsTheAgentBar`). Unlike {@link accountOwner}, it does not ask which
   * account is signed in.
   */
  readonly clearsAgentBar: boolean;
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
  /**
   * Whether the caller clears the front-door bar (`refuseFrontDoorChange`):
   * the owner, at this computer or over their own encrypted connection, the
   * bar for settings that decide what code DorkOS runs.
   */
  readonly frontDoorOwner: boolean;
  /**
   * Whether that bar refused the request for where it came from rather than
   * who sent it, so the answer can say to make the change on this computer.
   */
  readonly frontDoorElsewhere: boolean;
  /**
   * Whether the request's signed-in account, if any, is the install's owner
   * account: the document channel's operator rule (`isDocOperatorAccount`),
   * login on or off. A chat canvas's file save asks it.
   */
  readonly ownerOrNoAccount: boolean;
  /**
   * Whether this call is a person's read on the capability's own REST path:
   * the person proof that path mints for an `observe` call with no program
   * credential (`personCaller`). Never set for `/invoke` (`dorkos call`), MCP
   * or a program key. A read that must not answer a caller nobody named as
   * the owner asks it (DOR-4972).
   */
  readonly personOnRestPath: boolean;
}
