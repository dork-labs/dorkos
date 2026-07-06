import type { ReactNode } from 'react';
import { useAuthRequired } from '../model/use-auth-signal';
import { LoginScreen } from './LoginScreen';

interface AuthGuardProps {
  children: ReactNode;
}

/**
 * Renders the {@link LoginScreen} when the app-wide auth-required signal is set
 * (a gated request returned `401 AUTH_REQUIRED`), otherwise renders the app.
 *
 * Progressive disclosure: when login is disabled the signal is never set, so the
 * guard is a transparent pass-through and no auth UI appears anywhere. Wired into
 * the web shell only — Obsidian embedded mode (DirectTransport, in-process) never
 * mounts it and stays unauthenticated.
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const authRequired = useAuthRequired();
  if (authRequired) {
    return <LoginScreen />;
  }
  return <>{children}</>;
}
