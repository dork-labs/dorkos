/**
 * Cloud-link feature — the client surface for linking this DorkOS instance to a
 * DorkOS account (accounts-and-auth P2).
 *
 * Owns the device-link flow: the settled summary, the code display, live polling
 * to a terminal state, and unlink. Deliberately independent of local login — the
 * panel renders regardless of the auth session. Obsidian embedded mode
 * (DirectTransport) stubs the underlying transport methods and never mounts this
 * UI.
 *
 * FSD: `features/cloud-link` — imports only from `shared` and its own slice.
 * Sibling features compose its UI (Settings renders `CloudLinkPanel`).
 *
 * @module features/cloud-link
 */
export { CloudLinkPanel } from './ui/CloudLinkPanel';
export { useCloudLink, cloudStatusKey, type CloudLinkView } from './model/use-cloud-link';
