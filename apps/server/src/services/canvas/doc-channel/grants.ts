/** Stable public grant entry; original base/subclass and private registries initialize together. */
export {
  DocChannelGrants,
  configureOriginalDocChannel,
  approveOriginalDocRoute,
  revokeOriginalDocRoute,
  requireCurrentDocGrantEngine,
  grantOriginalPreparedCheckboxRoute,
} from './grant-revalidation.js';
export type { PreparedDocGrant, DocGrantResult, DocGrantedRoute } from './grant-revalidation.js';
