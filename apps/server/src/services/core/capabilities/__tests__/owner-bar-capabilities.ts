/**
 * Every capability that declares the account-decision bar (`http.ownerBar`,
 * DOR-4978), pinned by `owner-authority.test.ts`. Joining this list is a
 * reviewed edit: the capability's handler acts for the owner the bar resolved.
 *
 * @module services/core/capabilities/__tests__/owner-bar-capabilities
 */
export const OWNER_BAR_CAPABILITIES: readonly string[] = [
  'connectors.disconnect_impact',
  'connectors.rename_connection',
  'connectors.remove_connection',
];
