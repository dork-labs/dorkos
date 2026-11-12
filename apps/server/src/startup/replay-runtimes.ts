import { setCloudV1Fetch } from '../services/core/cloud/v1-client.js';
import { env } from '../env.js';
import { initCloudLinkManager } from '../services/core/auth/cloud-link.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { ReplaySource } from '../services/runtimes/test-mode/replay/source.js';
import { TestModeRuntime } from '../services/runtimes/test-mode/test-mode-runtime.js';
import type { RuntimeStartupDeps, RegisteredRuntimes } from './runtimes.js';

/** Register only data-driven test-mode instances; no real runtime or model client is constructed. */
export function registerReplayRuntimes(deps: RuntimeStartupDeps): RegisteredRuntimes {
  if (!env.DORKOS_TEST_RUNTIME || !env.DORKOS_REPLAY_RECORDING) {
    throw new Error('Recorded demo needs the test runtime and a recording.');
  }
  const source = new ReplaySource(deps.dorkHome, env.DORKOS_REPLAY_RECORDING);
  // Every Cloud method uses this transport, including explicit clicks after boot.
  const blockedFetch = async (): Promise<never> => {
    throw new Error('Recorded demo: Cloud is off.');
  };
  initCloudLinkManager({ fetchImpl: blockedFetch });
  setCloudV1Fetch(blockedFetch);
  const runtimes = ['test-mode', 'claude-code', 'codex'].map((type) => {
    const runtime = new TestModeRuntime(type, source);
    runtime.setSessionSettings(runtimeRegistry);
    runtimeRegistry.register(runtime);
    return runtime;
  });
  runtimeRegistry.setDefault('test-mode');
  return {
    claudeRuntime: null,
    doeRuntime: null,
    relayAgentRuntime: runtimes[0]!,
    creditsRelay: null,
  };
}
