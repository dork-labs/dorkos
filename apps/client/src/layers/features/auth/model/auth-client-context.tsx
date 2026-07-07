/**
 * Auth client context — provides the {@link AuthClient} to this slice's hooks.
 *
 * Defaults to the real app-wide {@link authClient} singleton, so `main.tsx` needs
 * no provider. Tests wrap components in {@link AuthClientProvider} with a fake
 * client to assert calls without hitting the network (mirrors `TransportProvider`).
 *
 * @module features/auth/model/auth-client-context
 */
import { createContext, useContext, type ReactNode } from 'react';
import { authClient, type AuthClient } from './auth-client';

const AuthClientContext = createContext<AuthClient>(authClient);

/** Provide an {@link AuthClient} to descendants (real singleton by default; a fake in tests). */
export function AuthClientProvider({
  client,
  children,
}: {
  client: AuthClient;
  children: ReactNode;
}) {
  return <AuthClientContext.Provider value={client}>{children}</AuthClientContext.Provider>;
}

/** Access the current {@link AuthClient} (the singleton unless a provider overrides it). */
export function useAuthClient(): AuthClient {
  return useContext(AuthClientContext);
}
