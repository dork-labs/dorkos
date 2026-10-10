/**
 * The test-mode DorkOS Cloud (DOR-2783): everything a `DORKOS_TEST_RUNTIME`
 * server needs so the account link, a credits token and a credits chat run
 * end to end with nothing leaving the machine and nothing charged.
 *
 * - the device-link transport (`fake-cloud-link.ts`), whose code is approved
 *   by opening `/api/test/fake-cloud/approve?code=` on this server;
 * - every `/v1` contract call (`fake-cloud-v1.ts`), through the `/v1` client's
 *   fetch seam;
 * - an OpenAI-compatible stream at `/api/test/fake-inference/v1`
 *   (`fake-inference.ts`) that the fake token's endpoints point at;
 * - with `DORKOS_TEST_RUNTIME_DOE=true`, the DorkOS runtime itself, beside
 *   `TestModeRuntime`, refusing any turn not paid by (fake) DorkOS credits, so
 *   it can never reach a real model service.
 *
 * Reached only through the gated dynamic `import()` in `index.ts`, so none of
 * it is in the production module graph.
 *
 * @module services/runtimes/test-mode/compose-test-cloud
 */
import type { RuntimeRegistry } from '../../core/runtime-registry.js';
import { initCloudLinkManager } from '../../core/auth/cloud-link.js';
import { setCloudV1Fetch } from '../../core/cloud/v1-client.js';
import { testControlRouter } from '../../../routes/test-control.js';
import { localDialHost } from '../../../lib/local-dial-host.js';
import { logger } from '../../../lib/logger.js';
import { env } from '../../../env.js';
import { DoeRuntime } from '../doe/index.js';
import type { DoeRuntimeOptions } from '../doe/doe-runtime.js';
import { resolveDoeInference } from '../doe/credentials.js';
import { createFakeCloudApprovalRouter, createFakeCloudLink } from './fake-cloud-link.js';
import { createFakeCloudV1Fetch } from './fake-cloud-v1.js';
import { createFakeInferenceRouter } from './fake-inference.js';

/** Why a test-mode DorkOS turn on anything but credits is refused. */
export const TEST_MODE_DOE_REFUSAL =
  'In test mode, the DorkOS runtime runs only on DorkOS credits.';

/**
 * The DorkOS runtime's options in test mode: a turn resolves its model only
 * when DorkOS credits pay for it, whose token the fake Cloud mints against the
 * fake inference stream. An own key or a local model would reach a real
 * endpoint, so it is refused before anything is sent.
 */
export function testModeDoeOptions(): DoeRuntimeOptions {
  return {
    resolveModel: async (config) => {
      if (config.source !== 'dorkos-credits') throw new Error(TEST_MODE_DOE_REFUSAL);
      return resolveDoeInference(config);
    },
  };
}

/**
 * Wire the test-mode Cloud into this server, and register the DorkOS runtime
 * when `DORKOS_TEST_RUNTIME_DOE` asks for it.
 *
 * @param registry - The runtime registry the DorkOS runtime joins.
 * @returns The DorkOS runtime when one was registered, else `null`.
 * @throws If called outside `DORKOS_TEST_RUNTIME`.
 */
export function composeTestModeCloud(registry: RuntimeRegistry): DoeRuntime | null {
  if (!env.DORKOS_TEST_RUNTIME) {
    throw new Error('composeTestModeCloud is test-mode only (DORKOS_TEST_RUNTIME)');
  }
  const origin = `http://${localDialHost(env.DORKOS_HOST)}:${env.DORKOS_PORT}`;
  const link = createFakeCloudLink({
    approvalUrl: `${origin}/api/test/fake-cloud/approve`,
    autoApprove: env.DORKOS_TEST_CLOUD_AUTO_APPROVE,
  });
  initCloudLinkManager({ fetchImpl: link.fetch });
  setCloudV1Fetch(
    createFakeCloudV1Fetch({ inferenceBaseUrl: `${origin}/api/test/fake-inference/v1` })
  );
  testControlRouter.use('/fake-cloud', createFakeCloudApprovalRouter(link));
  testControlRouter.use('/fake-inference', createFakeInferenceRouter());

  if (!env.DORKOS_TEST_RUNTIME_DOE) return null;
  const doe = new DoeRuntime(testModeDoeOptions());
  doe.setSessionSettings(registry);
  registry.register(doe);
  logger.info('[TestMode] DorkOS runtime registered against the test-mode Cloud');
  return doe;
}
