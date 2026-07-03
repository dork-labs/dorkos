import { CloudLinkPanel } from '@/layers/features/cloud-link';

/**
 * DorkOS account tab for the Settings dialog — links this instance to a DorkOS
 * account.
 *
 * A thin `features/settings` wrapper that composes the `features/cloud-link`
 * {@link CloudLinkPanel} (sibling UI composition). All link-flow logic lives in
 * the cloud-link slice; this only slots it into the settings surface. Shown
 * regardless of whether local login is enabled.
 */
export function CloudAccountTab() {
  return <CloudLinkPanel />;
}
