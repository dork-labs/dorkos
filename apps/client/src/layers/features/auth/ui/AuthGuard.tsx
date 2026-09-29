import type { ReactNode } from 'react';
import { useAuthRequired } from '../model/use-auth-signal';
import { LoginScreen } from './LoginScreen';

interface AuthGuardProps {
  children: ReactNode;
}

/**
 * Renders the {@link LoginScreen} when the app-wide auth-required signal is set
 * (a gated request returned `401 AUTH_REQUIRED`), otherwise renders the app.
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const authRequired = useAuthRequired();
  if (authRequired) {
    return <LoginScreen />;
  }
  return <>{children}</>;
}
