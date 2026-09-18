/**
 * Every path in the `/v1` contract, in one place.
 *
 * The paths are here so a caller never hand-builds one and so the conformance
 * fixtures can name a route without repeating a string. Nothing here is a URL:
 * the origin is a runtime value the caller supplies, and no host appears
 * anywhere in this package.
 */

/** The `/v1` paths that take no path parameter. */
export const V1_ROUTES = {
  session: '/v1/session',
  account: '/v1/account',
  accountExport: '/v1/account/export',
  deviceCode: '/v1/device/code',
  deviceToken: '/v1/device/token',
  instances: '/v1/instances',
  instancesHeartbeat: '/v1/instances/heartbeat',
  instancesRevoke: '/v1/instances/revoke',
  connections: '/v1/connections',
  connectionsCatalog: '/v1/connections/catalog',
  connectionsUsage: '/v1/connections/usage',
  connectionsAuthenticationFlows: '/v1/connections/authentication-flows',
  connectionsAuthorityCommands: '/v1/connections/authority-commands',
  connectionsExecutions: '/v1/connections/executions',
  connectionsEventsPull: '/v1/connections/events/pull',
  connectionsEventsAck: '/v1/connections/events/ack',
  entitlements: '/v1/entitlements',
  balance: '/v1/balance',
  usage: '/v1/usage',
  priceList: '/v1/price-list',
  nudge: '/v1/nudge',
  checkout: '/v1/checkout',
  topup: '/v1/topup',
  portal: '/v1/portal',
  refunds: '/v1/refunds',
  statement: '/v1/statement',
  inferenceTokens: '/v1/inference/tokens',
  inferenceModels: '/v1/inference/models',
  orgs: '/v1/orgs',
  addresses: '/v1/addresses',
  remoteStatus: '/v1/remote/status',
  remoteOpen: '/v1/remote/open',
  remoteClose: '/v1/remote/close',
  remoteWakeTokens: '/v1/remote/wake-tokens',
  remoteEnrolment: '/v1/remote/enrolment',
  remoteAddress: '/v1/remote/address',
  remoteCustomAddress: '/v1/remote/address/custom',
  remoteCredentialsIssue: '/v1/remote/credentials/issue',
  remoteCredentialsConfirm: '/v1/remote/credentials/confirm',
  remoteCommands: '/v1/remote/commands',
  remoteCommandsAck: '/v1/remote/commands/ack',
  remoteEvents: '/v1/remote/events',
} as const;

/** One of the fixed `/v1` paths. */
export type V1Route = (typeof V1_ROUTES)[keyof typeof V1_ROUTES];

/**
 * The `/v1` paths that take a path parameter, as builders.
 *
 * Each takes opaque identifiers and returns a path. Identifiers are
 * percent-encoded on the way in, and a dot segment is refused outright, so an
 * identifier cannot change which route is called. See {@link enc} for why
 * percent-encoding alone is not enough.
 */
export const v1Path = {
  /**
   * The route for one connection.
   *
   * @param connectionId - The connection's opaque identifier.
   */
  connection: (connectionId: string) => `/v1/connections/${enc(connectionId)}`,
  /**
   * The usage route for one connection.
   *
   * @param connectionId - The connection's opaque identifier.
   */
  connectionUsage: (connectionId: string) => `/v1/connections/${enc(connectionId)}/usage`,
  /**
   * The route for one toolkit's catalog version.
   *
   * @param toolkit - The toolkit's opaque identifier.
   */
  toolkitVersion: (toolkit: string) => `/v1/connections/toolkits/${enc(toolkit)}/version`,
  /**
   * The route for one toolkit's operations.
   *
   * @param toolkit - The toolkit's opaque identifier.
   */
  toolkitOperations: (toolkit: string) => `/v1/connections/toolkits/${enc(toolkit)}/operations`,
  /**
   * The route for one toolkit's events.
   *
   * @param toolkit - The toolkit's opaque identifier.
   */
  toolkitEvents: (toolkit: string) => `/v1/connections/toolkits/${enc(toolkit)}/events`,
  /**
   * The route for one authentication flow.
   *
   * @param flowId - The flow's opaque identifier.
   */
  authenticationFlow: (flowId: string) => `/v1/connections/authentication-flows/${enc(flowId)}`,
  /**
   * The route for one authority command.
   *
   * @param commandId - The command's opaque identifier.
   */
  authorityCommand: (commandId: string) => `/v1/connections/authority-commands/${enc(commandId)}`,
  /**
   * The route for one execution attempt.
   *
   * @param attemptId - The attempt's opaque identifier.
   */
  execution: (attemptId: string) => `/v1/connections/executions/${enc(attemptId)}`,
  /**
   * The route that relinks one instance to an organization.
   *
   * @param instanceId - The instance's opaque identifier.
   */
  instanceOrg: (instanceId: string) => `/v1/instances/${enc(instanceId)}/org`,
  /**
   * The revoke route for one minted inference token.
   *
   * @param tokenId - The token's opaque identifier.
   */
  inferenceTokenRevoke: (tokenId: string) => `/v1/inference/tokens/${enc(tokenId)}/revoke`,
  /**
   * The route for one organization.
   *
   * @param orgId - The organization's opaque identifier.
   */
  org: (orgId: string) => `/v1/orgs/${enc(orgId)}`,
  /**
   * The members route for one organization.
   *
   * @param orgId - The organization's opaque identifier.
   */
  orgMembers: (orgId: string) => `/v1/orgs/${enc(orgId)}/members`,
  /**
   * The route for one membership.
   *
   * @param orgId - The organization's opaque identifier.
   * @param memberId - The member's opaque identifier.
   */
  orgMember: (orgId: string, memberId: string) => `/v1/orgs/${enc(orgId)}/members/${enc(memberId)}`,
  /**
   * The invitations route for one organization.
   *
   * @param orgId - The organization's opaque identifier.
   */
  orgInvitations: (orgId: string) => `/v1/orgs/${enc(orgId)}/invitations`,
  /**
   * The route for one invitation within an organization.
   *
   * @param orgId - The organization's opaque identifier.
   * @param invitationId - The invitation's opaque identifier.
   */
  orgInvitation: (orgId: string, invitationId: string) =>
    `/v1/orgs/${enc(orgId)}/invitations/${enc(invitationId)}`,
  /**
   * The route that accepts one invitation.
   *
   * @param invitationId - The invitation's opaque identifier.
   */
  invitationAccept: (invitationId: string) => `/v1/invitations/${enc(invitationId)}/accept`,
  /**
   * The seats route for one organization.
   *
   * @param orgId - The organization's opaque identifier.
   */
  orgSeats: (orgId: string) => `/v1/orgs/${enc(orgId)}/seats`,
  /**
   * The agents route for one organization.
   *
   * @param orgId - The organization's opaque identifier.
   */
  orgAgents: (orgId: string) => `/v1/orgs/${enc(orgId)}/agents`,
  /**
   * The remote-designation route for one organization.
   *
   * @param orgId - The organization's opaque identifier.
   */
  orgRemoteDesignation: (orgId: string) => `/v1/orgs/${enc(orgId)}/remote/designation`,
  /**
   * The route for one agent.
   *
   * @param agentId - The agent's opaque identifier.
   */
  agent: (agentId: string) => `/v1/agents/${enc(agentId)}`,
  /**
   * The route that approves one agent claim.
   *
   * @param agentId - The agent's opaque identifier.
   * @param claimId - The claim's opaque identifier.
   */
  agentClaimApprove: (agentId: string, claimId: string) =>
    `/v1/agents/${enc(agentId)}/claims/${enc(claimId)}/approve`,
  /**
   * The route for one seat.
   *
   * @param seatId - The seat's opaque identifier.
   */
  seat: (seatId: string) => `/v1/seats/${enc(seatId)}`,
  /**
   * The assign route for one seat.
   *
   * @param seatId - The seat's opaque identifier.
   */
  seatAssign: (seatId: string) => `/v1/seats/${enc(seatId)}/assign`,
  /**
   * The suspend route for one seat.
   *
   * @param seatId - The seat's opaque identifier.
   */
  seatSuspend: (seatId: string) => `/v1/seats/${enc(seatId)}/suspend`,
  /**
   * The resume route for one seat.
   *
   * @param seatId - The seat's opaque identifier.
   */
  seatResume: (seatId: string) => `/v1/seats/${enc(seatId)}/resume`,
  /**
   * The release route for one seat.
   *
   * @param seatId - The seat's opaque identifier.
   */
  seatRelease: (seatId: string) => `/v1/seats/${enc(seatId)}/release`,
  /**
   * The grants route for one seat.
   *
   * @param seatId - The seat's opaque identifier.
   */
  seatGrants: (seatId: string) => `/v1/seats/${enc(seatId)}/grants`,
  /**
   * The add-ons route for one seat.
   *
   * @param seatId - The seat's opaque identifier.
   */
  seatAddons: (seatId: string) => `/v1/seats/${enc(seatId)}/addons`,
  /**
   * The route for one add-on kind on one seat.
   *
   * @param seatId - The seat's opaque identifier.
   * @param kind - The add-on's opaque identifier.
   */
  seatAddon: (seatId: string, kind: string) => `/v1/seats/${enc(seatId)}/addons/${enc(kind)}`,
  /**
   * The read-only inbox browse route for one seat.
   *
   * @param seatId - The seat's opaque identifier.
   */
  seatInbox: (seatId: string) => `/v1/seats/${enc(seatId)}/inbox`,
  /**
   * The inbox pull route for one seat.
   *
   * @param seatId - The seat's opaque identifier.
   */
  seatInboxPull: (seatId: string) => `/v1/seats/${enc(seatId)}/inbox/pull`,
  /**
   * The inbox acknowledgement route for one seat.
   *
   * @param seatId - The seat's opaque identifier.
   */
  seatInboxAck: (seatId: string) => `/v1/seats/${enc(seatId)}/inbox/ack`,
  /**
   * The presence route for one seat.
   *
   * @param seatId - The seat's opaque identifier.
   */
  seatPresence: (seatId: string) => `/v1/seats/${enc(seatId)}/presence`,
  /**
   * The route for one address.
   *
   * @param addressId - The address's opaque identifier.
   */
  address: (addressId: string) => `/v1/addresses/${enc(addressId)}`,
} as const;

/**
 * Encodes one opaque identifier for use as a single path segment.
 *
 * Percent-encoding alone does **not** make an identifier safe here, and the
 * reason is worth writing down because it is easy to assume otherwise:
 * `encodeURIComponent('..')` is `'..'`, because a dot is an unreserved
 * character. The dot segment survives encoding intact, and `new URL()` then
 * resolves it — so `v1Path.seatRelease('..')` would build `/v1/seats/../release`
 * and be requested as `/v1/release`, and two dot segments escape `/v1`
 * altogether. An identifier that can move the request to another route is a
 * confused-deputy bug, and several of these identifiers (an add-on kind, a
 * toolkit slug) come from values a caller supplies.
 *
 * So a dot segment is refused rather than encoded. Refusing is right for an
 * identifier the server issued: `.` and `..` are not identifiers this service
 * hands out, so a caller holding one is already in a state no encoding would
 * make correct, and failing loudly at the call site beats silently requesting
 * a different route.
 *
 * @param segment - The opaque identifier to place in one path segment.
 * @throws TypeError - When the identifier is empty or is a dot segment.
 */
function enc(segment: string): string {
  if (segment === '') {
    throw new TypeError('A route identifier must not be empty.');
  }
  if (segment === '.' || segment === '..') {
    throw new TypeError(
      `A route identifier must not be a dot segment (received ${JSON.stringify(segment)}); it would change which route is called.`
    );
  }
  return encodeURIComponent(segment);
}
