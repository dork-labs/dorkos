import { SecurityPanel } from '@/layers/features/auth';

/**
 * Security tab for the Settings dialog — local login and API keys.
 *
 * A thin `features/settings` wrapper that composes the `features/auth`
 * {@link SecurityPanel} (sibling UI composition). All auth logic lives in the
 * auth slice; this only slots it into the settings surface.
 */
export function SecurityTab() {
  return <SecurityPanel />;
}
