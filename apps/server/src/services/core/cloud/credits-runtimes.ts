/**
 * The registered runtimes as the credits defaults see them: what each one
 * declares, and whether its own sign-in works right now.
 *
 * @module services/core/cloud/credits-runtimes
 */
import { deriveRuntimeReadiness } from '@dorkos/shared/agent-runtime';
import type { CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import { runtimeRegistry } from '../runtime-registry.js';
import { creditsChoices, creditsNotices, readCreditsSettings } from './credits-defaults.js';
import type { CreditsRuntimeView } from './credits-defaults.js';
import { creditsWiringReport } from './credits-inference.js';
import { isCloudLinked } from './v1-client.js';

/**
 * Every registered runtime, with a sign-in check that reads the same
 * readiness the Runtimes screen shows (`GET /api/system/requirements`).
 */
export function creditsRuntimeViews(): CreditsRuntimeView[] {
  return runtimeRegistry.listRuntimes().map((runtime) => ({
    type: runtime.type,
    capabilities: runtime.getCapabilities(),
    hasWorkingSignIn: async () =>
      deriveRuntimeReadiness(runtime.type, await runtime.checkDependencies()).state === 'ready',
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
