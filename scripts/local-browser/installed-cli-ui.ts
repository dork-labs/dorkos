/** Owns the isolated installed CLI UI browser and its bounded physical cleanup. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { BrowserContext } from '../../packages/cli/node_modules/playwright-core/index.js';
import {
  proofUiDriver,
  proveInstalledLocalBrowserUi,
  proveInstalledPreparationFailure,
} from '../../apps/e2e/pages/local-browser-installed-proof.js';

import { bounded, ownedChromeCleanup } from './owned-chrome-cleanup.js';

export { proofUiDriver };

interface InstalledCliEnvironmentPaths {
  dataDirectory: string;
  fixtureHome: string;
  browserCache: string;
}

/** Keep installer settings and system paths while stripping model and private bridge credentials. */
export function installedCliEnvironment(
  inherited: NodeJS.ProcessEnv,
  paths: InstalledCliEnvironmentPaths
): NodeJS.ProcessEnv {
  const safe = Object.fromEntries(
    Object.entries(inherited).filter(
      ([name]) =>
        !/^(npm_config_|PW_|PLAYWRIGHT_)/i.test(name) &&
        !name.startsWith('DORKOS_') &&
        !name.startsWith('DORK_') &&
        !/(KEY|TOKEN|SECRET|PASSWORD|PAID|CREDENTIALED|HARNESS_SMOKE|COMMUNITY_LIVE)/i.test(name) &&
        ![
          'NODE_OPTIONS',
          'NODE_PATH',
          'BASH_ENV',
          'ENV',
          'ZDOTDIR',
          'DEBUG',
          'PWDEBUG',
          'SSH_AUTH_SOCK',
          'SSH_AGENT_PID',
          'SSH_ASKPASS',
          'GIT_ASKPASS',
          'DORKOS_MANAGED_BY',
          'DORKOS_LOCAL_BROWSER_BRIDGE',
          'DORKOS_LOCAL_BROWSER_BRIDGE_TOKEN',
          'ELECTRON_RUN_AS_NODE',
        ].includes(name)
    )
  );
  return {
    ...safe,
    npm_config_cache: path.join(paths.fixtureHome, 'npm-cache'),
    npm_config_userconfig: path.join(paths.fixtureHome, 'npmrc'),
    npm_config_globalconfig: path.join(paths.fixtureHome, 'global-npmrc'),
    npm_config_global: 'false',
    DORK_HOME: paths.dataDirectory,
    CFFIXED_USER_HOME: paths.fixtureHome,
    DORKOS_HOST: '127.0.0.1',
    PLAYWRIGHT_BROWSERS_PATH: paths.browserCache,
    DORKOS_TEST_RUNTIME: 'true',
    DORKOS_TASKS_ENABLED: 'false',
    DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
    DORKOS_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
  };
}

interface InstalledCliUiOptions {
  driver: typeof import('../../packages/cli/node_modules/playwright-core/index.js').chromium;
  env: NodeJS.ProcessEnv;
  sandbox: string;
  dataDirectory: string;
  base: string;
  output: string;
  receipt: Record<string, unknown>;
}

/** Create before running so the caller can retry cleanup from its outer finally. */
export function installedCliUi(options: InstalledCliUiOptions) {
  const { driver, env, sandbox, dataDirectory, base, output, receipt } = options;
  const exec = promisify(execFile);
  const uiProfile = path.join(sandbox, 'ui-browser-profile');
  let owner: BrowserContext | undefined;
  let cleanup: ReturnType<typeof ownedChromeCleanup> | undefined;
  let captureTimer: ReturnType<typeof setInterval> | undefined;

  async function close(): Promise<void> {
    clearInterval(captureTimer);
    let failure: unknown;
    if (owner) {
      try {
        await bounded(owner.close(), 10_000, 'Owned UI browser close');
        owner = undefined;
      } catch (error) {
        receipt.uiCloseError = String(error);
        failure = error;
      }
    }
    if (cleanup) {
      try {
        await bounded(cleanup.close(), 60_000, 'Owned UI browser physical cleanup');
        cleanup = undefined;
      } catch (error) {
        receipt.uiCleanupError = String(error);
        failure = error;
      }
    }
    if (failure) throw failure;
  }

  async function run(kind: 'normal' | 'preparation-error' = 'normal'): Promise<unknown> {
    try {
      // The parent supplies its sanitized environment, including its isolated CFFIXED_USER_HOME.
      owner = await driver.launchPersistentContext(uiProfile, { headless: true, env });
      const browser = owner.browser();
      assert(browser, 'The owned UI context must expose its browser');
      const processes = (
        await exec('ps', ['-axo', 'pid=,pgid=,command='], {
          timeout: 2_000,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout
        .split('\n')
        .flatMap((line) => {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
          return match &&
            match[1] === match[2] &&
            match[3]!.includes('--user-data-dir=' + uiProfile)
            ? [Number(match[1])]
            : [];
        });
      assert.equal(processes.length, 1, 'Find exactly one owned detached UI browser');
      cleanup = ownedChromeCleanup(processes[0]!, uiProfile);
      await cleanup.capture();
      captureTimer = setInterval(() => {
        void cleanup?.capture().catch((error: unknown) => {
          receipt.uiCensusError = String(error);
        });
      }, 500);
      return {
        uiRunner: {
          source: 'workspace @playwright/test',
          executable: driver.executablePath(),
          browserVersion: browser.version(),
          version: '1.63.0',
          cache: 'existing host runner cache',
        },
        appBackend: {
          source: 'isolated installed playwright-core',
          cache: env.PLAYWRIGHT_BROWSERS_PATH,
        },
        evidence: await (
          kind === 'preparation-error'
            ? proveInstalledPreparationFailure
            : proveInstalledLocalBrowserUi
        )(
          browser,
          base,
          path.join(output, kind === 'preparation-error' ? 'ui-preparation-error' : 'ui'),
          dataDirectory
        ),
      };
    } finally {
      await close();
    }
  }

  return { run, close };
}

export const installedCliProofGaps = [
  'No Windows/Linux installed proof performed.',
  'Embedded desktop panel/PiP inspection and desktop artifact proof are separate.',
];

/** Identify which installed backend performed the UI's real first-use acquisition. */
export function firstUseAcquisitionMetadata(backend: string, uiEvidence: unknown) {
  return {
    initiatedBy: 'installed UI first-use open, cancel, retry',
    installedBackend: backend,
    preparationEvidence: uiEvidence,
  };
}

/** Refuse the actual first download, then restart the same install with its original network settings. */
export async function provePreparationFailureThenStart<T>(
  ui: ReturnType<typeof installedCliUi>,
  env: NodeJS.ProcessEnv,
  start: (suffix: string) => Promise<T>,
  stop: () => Promise<void>,
  checks: Record<string, unknown>
): Promise<T> {
  const names = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  const original = names.map((name) => [name, env[name]] as const);
  Object.assign(env, {
    HTTPS_PROXY: 'http://127.0.0.1:1',
    HTTP_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost',
  });
  try {
    await start('preparation-error');
    checks.preparationErrorUi = await ui.run('preparation-error');
  } finally {
    try {
      await stop();
    } finally {
      for (const [name, value] of original) {
        if (value === undefined) delete env[name];
        else env[name] = value;
      }
    }
  }
  return start('fresh');
}

/** Qualify the app's untouched private cache before either first-use UI proof can acquire it. */
export async function qualifyFreshInstalledCache(cache: string, executable: string) {
  const entries = await readdir(cache);
  assert.equal(
    entries.length,
    0,
    'Automatic preparation proof must start without a browser executable'
  );
  assert(executable.startsWith(cache + path.sep));
  return { entries: entries.length };
}
