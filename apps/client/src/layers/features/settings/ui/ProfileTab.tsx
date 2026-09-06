import { ProfilePanelContainer } from '@/layers/features/profile';

/**
 * Profile tab for the Settings dialog — your photo, your name, your `@handle`.
 *
 * A thin `features/settings` wrapper that composes the `features/profile`
 * {@link ProfilePanelContainer} (sibling UI composition), exactly as the
 * Access tab composes the auth slice's panel. Everything about who you are
 * lives in the profile slice; this only slots it into the settings surface.
 */
export function ProfileTab() {
  return <ProfilePanelContainer />;
}
