/**
 * Cloud-link feature — the client surface for linking this DorkOS instance to a
 * DorkOS account (accounts-and-auth P2).
 *
 * FSD: `features/cloud-link` — imports only from `shared` and its own slice.
 * Sibling features compose its UI (Settings renders `CloudLinkPanel`).
 *
 * @module features/cloud-link
 */
export { CloudLinkPanel } from './ui/CloudLinkPanel';
export { useCloudLink, cloudStatusKey, type CloudLinkView } from './model/use-cloud-link';
