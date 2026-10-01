/**
 * Cloud-link feature — the client surface for linking this DorkOS instance to a
 * DorkOS account (accounts-and-auth P2).
 *
 * FSD: `features/cloud-link` — imports only from `shared` and its own slice.
 * Sibling features compose its UI (Settings renders `CloudLinkPanel`; the plan
 * section and the hosted-community dialogs render `CloudEligibilityNote`).
 *
 * @module features/cloud-link
 */
export { CloudLinkPanel } from './ui/CloudLinkPanel';
export {
  CloudEligibilityNote,
  CLOUD_ELIGIBILITY_TEXT,
  CLOUD_ELIGIBILITY_URL,
  type CloudEligibilityNoteProps,
} from './ui/CloudEligibilityNote';
export {
  useCloudLink,
  useCloudStatus,
  cloudStatusKey,
  type CloudLinkView,
} from './model/use-cloud-link';
