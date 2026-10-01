/**
 * The registered runtimes as the credits defaults see them: what each one
 * declares, and where its own sign-in stands right now.
 *
 * @module services/core/cloud/credits-runtimes
 */
import { deriveRuntimeReadiness, type DependencyCheck } from '@dorkos/shared/agent-runtime';
import type { CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import { runtimeRegistry } from '../runtime-registry.js';
import { creditsChoices, creditsNotices, readCreditsSettings } from './credits-defaults.js';
import type { CreditsRuntimeView, RuntimeSignInState } from './credits-defaults.js';
import { creditsWiringReport } from './credits-inference.js';
import { isCloudLinked } from './v1-client.js';

/**
 * Where a runtime's own sign-in stands, read off the same dependency checks
 * the Runtimes screen shows (`GET /api/system/requirements`):
 *
 * - ready → `working`;
 * - an auth check that is missing WITH a known deadline, or outdated → the
 *   sign-in exists and ran out: `needs-attention`, never a gap;
 * - an auth check missing with no deadline → `none`, no sign-in at all.
 *
 * Anything this cannot classify reads as `needs-attention`, which fills
 * nothing: only a plain "no sign-in" may ever be filled with credits.
 *
 * @param type - The runtime type.
 * @param dependencies - Its dependency checks.
 */
export function signInStateOf(
  type: string,
  dependencies: readonly DependencyCheck[]
): RuntimeSignInState {
  if (deriveRuntimeReadiness(type, [...dependencies]).state === 'ready') return 'working';
  const binary = dependencies.find((d) => /\bCLI\b/i.test(d.name)) ?? dependencies[0];
  const auth = dependencies.find((d) => d !== binary && /auth|login/i.test(d.name));
  if (!auth) return 'needs-attention';
  if (auth.status === 'missing' && auth.expiresAt === undefined) return 'none';
  return 'needs-attention';
}

/** Every registered runtime, with its declared capabilities and its sign-in state. */
export function creditsRuntimeViews(): CreditsRuntimeView[] {
  return runtimeRegistry.listRuntimes().map((runtime) => ({
    type: runtime.type,
    capabilities: runtime.getCapabilities(),
    signIn: async () => signInStateOf(runtime.type, await runtime.checkDependencies()),
  }));
}

/**
 * The full `GET /api/cloud/credits` answer: the wiring, the choices and the
 * notices owed. Carries no credential.
 */
export async function creditsStatus(): Promise<CloudCreditsStatus> {
  const views = creditsRuntimeViews();
  const settings = readCreditsSettings();
  const report = creditsWiringReport(
    views.map((view) => ({ type: view.type, ...view.capabilities }))
  );
  return {
    ...report,
    defaults: creditsChoices(settings),
    notices: await creditsNotices(settings, { linked: isCloudLinked(), runtimes: views }),
  };
}
