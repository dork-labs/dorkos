/**
 * Where the runtime setup reads on the capability mount read
 * (`services/core/runtime-doors/runtime-read-capabilities.ts`, DOR-4978): the
 * same services the hand routes called, wired in by the composition layer so
 * the front-door module never imports runtime code.
 *
 * @module routes/runtime-settings-reader
 */
import type { RuntimeSettingsReader } from '../services/core/runtime-doors/runtime-read-capabilities.js';
import { getAccountUsageStore } from '../services/core/usage/current-usage-store.js';
import { configManager } from '../services/core/config-manager.js';
import { findUnregisteredClaudeFolders } from '../services/runtimes/claude-code/accounts/found-claude-folders.js';
import {
  readOpenCodeDirectSetup,
  readRuntimeKeyStatus,
} from '../services/runtimes/connect/credentials.js';
import { doeCreditsInUse, peekDoeCreditsPick } from '../services/runtimes/doe/auto-model.js';
import { readAccountEligibility } from './runtimes-account-eligibility.js';

/**
 * The reader the running server serves the runtime setup reads from.
 *
 * @returns The reader.
 */
export function runtimeSettingsReader(): RuntimeSettingsReader {
  return {
    accountUsage: (runtime) => getAccountUsageStore()?.list(runtime) ?? null,
    foundAccounts: () => findUnregisteredClaudeFolders({ runtimes: configManager.get('runtimes') }),
    accountEligibility: readAccountEligibility,
    runtimeKeyStatus: (type) => readRuntimeKeyStatus(type),
    openCodeKeySetup: () => readOpenCodeDirectSetup(),
    doeInference: () => {
      const inference = configManager.get('runtimes').doe.inference;
      // Which format DorkOS picks a model in when nothing is configured: only while
      // credits are in use here, and with no request made.
      const autoProtocol = doeCreditsInUse() ? (peekDoeCreditsPick()?.protocol ?? null) : null;
      if (!inference) return { inference: null, hasKey: false, autoProtocol };
      // The key reference stays on the server.
      const { credentialRef, credentialEndpoint: _endpoint, ...metadata } = inference;
      return { inference: metadata, hasKey: Boolean(credentialRef), autoProtocol };
    },
  };
}
