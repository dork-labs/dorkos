/**
 * The registered runtimes as the credits defaults see them: what each one
 * declares, and where its own sign-in stands right now.
 *
 * @module services/core/cloud/credits-runtimes
 */
import { deriveRuntimeSignIn } from '@dorkos/shared/agent-runtime';
import type { CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import { runtimeRegistry } from '../runtime-registry.js';
import {
  creditsChoices,
  creditsNotices,
  fillCreditsGaps,
  readCreditsSettings,
} from './credits-defaults.js';
import type { CreditsRuntimeView } from './credits-defaults.js';
import {
  awaitCreditsToken,
  creditsRuntimeWired,
  creditsWiringReport,
} from './credits-inference.js';
import { creditsCapabilitiesFor } from './credits-protocols.js';
import { isCloudLinked } from './v1-client.js';

/** Every registered runtime, with its declared capabilities, whether credits reach it, and its sign-in state. */
export function creditsRuntimeViews(): CreditsRuntimeView[] {
  return runtimeRegistry.listRuntimes().map((runtime) => {
    const capabilities = creditsCapabilitiesFor(runtime);
    return {
      type: runtime.type,
      capabilities,
      wired: creditsRuntimeWired(capabilities),
      signIn: async () => deriveRuntimeSignIn(runtime.type, await runtime.checkDependencies()),
    };
  });
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

/**
 * A new link's gap fill (ADR 261001-000811), after the link's first token has
 * been minted (or the bounded wait for it has passed). Which runtimes credits
 * reach depends on the formats that token lists, so filling before it arrives
 * would read every runtime but Claude Code as unreachable and leave it
 * unfilled for good; filling on a guess would be worse.
 *
 * @param accountKey - The account the new link was made under.
 * @param waitForToken - The bounded wait for the first token.
 * @returns The runtimes switched to credits.
 */
export async function fillCreditsGapsOnNewLink(
  accountKey: string | null,
  waitForToken: () => Promise<boolean> = () => awaitCreditsToken()
): Promise<string[]> {
  await waitForToken();
  return fillCreditsGaps(creditsRuntimeViews(), { key: accountKey });
}

/**
 * Stop every Codex turn running on DorkOS credits, when Codex is registered.
 * Structural, because the Codex runtime is constructed inside an optional
 * registration and is not held by the composition root.
 */
export function stopCodexCreditsTurns(): void {
  const codex = runtimeRegistry.listRuntimes().find((runtime) => runtime.type === 'codex') as
    { stopCreditsTurns?: () => void } | undefined;
  codex?.stopCreditsTurns?.();
}
