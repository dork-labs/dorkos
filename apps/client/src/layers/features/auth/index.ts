/**
 * Auth feature — the client surface for local (Better Auth) login.
 *
 * Owns the login screen, owner-account setup, the session guard, sign-out, and
 * per-user API key management. All server auth I/O is confined to this slice's
 * model (`/api/auth/*` behind hooks); no component imports the auth client
 * directly, and progressive disclosure keeps every affordance hidden until login
 * is enabled. Obsidian embedded mode (DirectTransport) never mounts this UI.
 *
 * FSD: `features/auth` — imports only from `entities` / `shared` and its own
 * slice. Sibling features compose its UI (e.g. Settings renders `SecurityPanel`).
 *
 * @module features/auth
 */

// ── UI ───────────────────────────────────────────────────────────────────────
export { AuthGuard } from './ui/AuthGuard';
export { LoginScreen } from './ui/LoginScreen';
export { OwnerSetupScreen } from './ui/OwnerSetupScreen';
export { OwnerSetupHost } from './ui/OwnerSetupHost';
export { SecurityPanel } from './ui/SecurityPanel';
export { ApiKeysSection } from './ui/ApiKeysSection';

// ── Model: auth client seam ──────────────────────────────────────────────────
export { AuthClientProvider, useAuthClient } from './model/auth-client-context';
export { createAuthRestClient, authClient } from './model/auth-client';
export type {
  AuthClient,
  AuthUser,
  AuthSession,
  AuthError,
  AuthResult,
  ApiKeyRecord,
  CreatedApiKey,
} from './model/auth-client';

// ── Model: hooks ─────────────────────────────────────────────────────────────
export {
  useAuthSession,
  useCurrentUser,
  useSignIn,
  useSignUp,
  useSignOut,
  authSessionKey,
  type AuthActionResult,
} from './model/use-auth-session';
export { useApiKeys, useCreateApiKey, useRevokeApiKey, apiKeysKey } from './model/use-api-keys';
export { useAuthRequired, useOwnerSetupRequest } from './model/use-auth-signal';
