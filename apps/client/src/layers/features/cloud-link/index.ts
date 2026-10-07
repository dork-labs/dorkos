/**
 * Cloud-link feature — the client surface for linking this DorkOS instance to a
 * DorkOS account (accounts-and-auth P2), and the ONE link flow every surface
 * that offers the account starts (spec `dorkos-account-by-default` §3).
 *
 * FSD: `features/cloud-link` — imports from `entities`, `shared` and its own
 * slice. Sibling features compose its UI (Settings renders `CloudLinkPanel`;
 * the plan section and the hosted-community dialogs render
 * `CloudEligibilityNote`). The default-first card that starts a link from a
 * runtime's connect step is composed one layer up (`widgets/credits-offer`) and
 * reaches features through the slot in `shared/model`, so no feature has to
 * import this one's flow.
 *
 * @module features/cloud-link
 */
export { CloudLinkPanel } from './ui/CloudLinkPanel';
export { CloudLinkInline, type CloudLinkInlineProps } from './ui/CloudLinkInline';
export {
  CloudEligibilityNote,
  CLOUD_ELIGIBILITY_TEXT,
  CLOUD_ELIGIBILITY_TEXT_WITHOUT_SPACES,
  CLOUD_ELIGIBILITY_URL,
  type CloudEligibilityNoteProps,
} from './ui/CloudEligibilityNote';
export {
  useCheckCloudLink,
  useCloudLink,
  useCloudStatus,
  cloudStatusKey,
  cloudLinkStatusKey,
  type CheckCloudLinkOptions,
  type CloudLinkView,
  type LandedLink,
  type StartCloudLinkOptions,
  type UseCloudLink,
} from './model/use-cloud-link';
