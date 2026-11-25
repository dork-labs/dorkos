/**
 * What an install reports about itself (DOR-4988): never the name the person
 * typed, never free text from the marketplace field, a placeholder for a
 * folder install, an honest source kind, and only error-class-shaped codes.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { InstallTelemetryEventSchema } from '@dorkos/shared/marketplace-install-telemetry';

import { InstallDispatcher } from '../../installer/install-dispatch.js';
import type { InstallerDeps } from '../../installer/marketplace-installer.js';
import type { PackageStager } from '../../installer/staging.js';
import type { ResolvedPackageSource } from '../../package-resolver.js';
import {
  DIRECT_SOURCE_LABEL,
  LOCAL_PACKAGE_LABEL,
  UNRESOLVED_PACKAGE_LABEL,
  buildInstallEvent,
  installSourceType,
} from '../install-event.js';
import {
  _resetTelemetryReporter,
  registerTelemetryReporter,
  type InstallEvent,
} from '../telemetry-hook.js';
import { buildPayload } from '../telemetry-reporter.js';

const INSTALL_ID = '7c6d2b9a-9f44-4f3a-bf67-3f3aa6bbf7c4';
const CONFIGURED = new Set(['dorkos-community']);

/**
 * Run a dispatcher whose resolve fails, and return the event it reported and
 * the body that would be sent. Only `dorkos-community` is a configured
 * marketplace.
 */
async function failedInstall(
  name: string,
  marketplace?: string
): Promise<{ event: InstallEvent; body: string }> {
  const events: InstallEvent[] = [];
  registerTelemetryReporter(async (event) => {
    events.push(event);
  });
  const stager = {
    resolveAndValidate: () => Promise.reject(new Error(`could not resolve ${name}`)),
  } as unknown as PackageStager;
  const deps = {
    resolver: { isConfiguredMarketplace: async (m: string) => CONFIGURED.has(m) },
  } as unknown as InstallerDeps;
  const dispatcher = new InstallDispatcher(deps, stager);
  await expect(dispatcher.installStaged({ name, marketplace })).rejects.toThrow();
  expect(events).toHaveLength(1);
  const event = events[0]!;
  return { event, body: JSON.stringify(buildPayload(event, INSTALL_ID, '1.2.3')) };
}

afterEach(() => _resetTelemetryReporter());

describe('an install that fails before its package resolves', () => {
  it.each([
    ['a folder path', '/Users/kai-example/private-client-work/agent-pack'],
    ['a github shorthand', 'github:kai-example/secret-repo'],
    ['a URL carrying a token', 'pack@https://kai:ghp_madeUpToken123@git.example.com/kai/pack.git'],
  ])('never sends %s anywhere in the payload', async (_label, name) => {
    const { event, body } = await failedInstall(name);

    expect(body).not.toContain(name);
    for (const part of [
      'kai-example',
      'secret-repo',
      'private-client-work',
      'ghp_madeUpToken123',
    ]) {
      expect(body).not.toContain(part);
    }
    expect(event.packageName).toBe(UNRESOLVED_PACKAGE_LABEL);
    expect(event.marketplace).toBe(DIRECT_SOURCE_LABEL);
    expect(event.sourceType).toBe('unknown');
    expect(InstallTelemetryEventSchema.safeParse(JSON.parse(body)).success).toBe(true);
  });
});

describe('installSourceType', () => {
  const resolved = (r: Partial<ResolvedPackageSource>): ResolvedPackageSource => ({
    kind: 'marketplace',
    packageName: 'code-reviewer',
    ...r,
  });

  it.each<[string, ResolvedPackageSource | null, string]>([
    ['nothing resolved', null, 'unknown'],
    ['a folder on this computer', resolved({ kind: 'local', localPath: '/tmp/pack' }), 'local'],
    [
      'a github shorthand',
      resolved({ kind: 'git', pluginSource: { source: 'url', url: 'https://github.com/a/b' } }),
      'github',
    ],
    [
      'a direct non-GitHub URL',
      resolved({ kind: 'git', pluginSource: { source: 'url', url: 'https://gitlab.com/a/b' } }),
      'url',
    ],
    [
      'a relative-path marketplace entry',
      resolved({ pluginSource: './plugins/a' }),
      'relative-path',
    ],
    [
      'a github marketplace entry',
      resolved({ pluginSource: { source: 'github', repo: 'a/b' } }),
      'github',
    ],
    [
      'a marketplace entry declared as a URL',
      resolved({ pluginSource: { source: 'url', url: 'https://github.com/a/b' } }),
      'url',
    ],
  ])('labels %s', (_label, source, expected) => {
    expect(installSourceType(source)).toBe(expected);
  });
});

describe('buildInstallEvent', () => {
  const base = {
    packageType: 'plugin' as const,
    outcome: 'failure' as const,
    durationMs: 12,
  };

  it('uses the resolved name and marketplace once resolved', () => {
    const event = buildInstallEvent({
      ...base,
      resolved: {
        kind: 'marketplace',
        packageName: 'code-reviewer',
        marketplaceName: 'dorkos-community',
        pluginSource: './plugins/code-reviewer',
      },
      packageType: 'shape',
      configuredMarketplace: 'something-else',
      outcome: 'success',
    });
    expect(event).toMatchObject({
      packageName: 'code-reviewer',
      marketplace: 'dorkos-community',
      type: 'shape',
      sourceType: 'relative-path',
    });
  });

  it.each(['success', 'failure'] as const)(
    'sends <local>, never the folder name, for a %s folder install',
    (outcome) => {
      const event = buildInstallEvent({
        ...base,
        outcome,
        resolved: {
          kind: 'local',
          packageName: 'kais-client-project',
          localPath: '/Users/kai-example/kais-client-project',
        },
      });
      expect(event.packageName).toBe(LOCAL_PACKAGE_LABEL);
      expect(JSON.stringify(event)).not.toContain('kai');
    }
  );
});
