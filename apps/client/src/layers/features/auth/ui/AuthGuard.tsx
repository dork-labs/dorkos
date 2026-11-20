import type { ReactNode } from 'react';
import { useAuthRequired, useSignInWith } from '../model/use-auth-signal';
import { usePublicComputerIdleSignOut } from '../model/use-auth-session';
import { DorkOSSignInScreen } from './DorkOSSignInScreen';
import { LoginScreen } from './LoginScreen';
import { WifiSignInScreen } from './WifiSignInScreen';

interface AuthGuardProps {
  children: ReactNode;
}

/**
 * Renders a sign-in screen when the app-wide auth-required signal is set (a
 * gated request returned `401 AUTH_REQUIRED`), otherwise renders the app: the
 * {@link DorkOSSignInScreen} when the server said to sign in with a DorkOS
 * account, the {@link WifiSignInScreen} over Wi-Fi, else the {@link LoginScreen}.
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const authRequired = useAuthRequired();
  const signInWith = useSignInWith();
  usePublicComputerIdleSignOut();
  if (authRequired) {
    if (signInWith === 'dorkos') return <DorkOSSignInScreen />;
    if (signInWith === 'wifi-code') return <WifiSignInScreen />;
    return <LoginScreen />;
  }
  return <>{children}</>;
}
