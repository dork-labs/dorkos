/**
 * What an install reports about itself (DOR-4988): never the name the person
 * typed, an honest source kind, and the requested marketplace when the package
 * never resolved.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { InstallTelemetryEventSchema } from '@dorkos/shared/marketplace-install-telemetry';

import { InstallDispatcher } from '../../installer/install-dispatch.js';
import type { InstallerDeps } from '../../installer/marketplace-installer.js';
import type { PackageStager } from '../../installer/staging.js';
import type { ResolvedPackageSource } from '../../package-resolver.js';
import {
  DIRECT_SOURCE_LABEL,
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

/** Run a dispatcher whose resolve fails, and return the event it reported. */
async function failedInstallEvent(name: string, marketplace?: string): Promise<InstallEvent> {
  const events: InstallEvent[] = [];
  registerTelemetryReporter(async (event) => {
    events.push(event);
  });
  const stager = {
    resolveAndValidate: () => Promise.reject(new Error(`could not resolve ${name}`)),
  } as unknown as PackageStager;
  const dispatcher = new InstallDispatcher({} as InstallerDeps, stager);
  await expect(dispatcher.installStaged({ name, marketplace })).rejects.toThrow();
  expect(events).toHaveLength(1);
  return events[0]!;
}

afterEach(() => _resetTelemetryReporter());

describe('an install that fails before its package resolves', () => {
  it.each([
    ['a folder path', '/Users/kai-example/private-client-work/agent-pack'],
    ['a github shorthand', 'github:kai-example/secret-repo'],
    ['a URL carrying a token', 'pack@https://kai:ghp_madeUpToken123@git.example.com/kai/pack.git'],
  ])('never sends %s anywhere in the payload', async (_label, name) => {
    const event = await failedInstallEvent(name);
    const body = JSON.stringify(buildPayload(event, INSTALL_ID, '1.2.3'));

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

  it('reports the marketplace the request named', async () => {
    const event = await failedInstallEvent('code-reviewer', 'dorkos-community');
    expect(event.marketplace).toBe('dorkos-community');
    expect(event.packageName).toBe(UNRESOLVED_PACKAGE_LABEL);
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
  it('uses the resolved name and marketplace once resolved', () => {
    const event = buildInstallEvent({
      resolved: {
        kind: 'marketplace',
        packageName: 'code-reviewer',
        marketplaceName: 'dorkos-community',
        pluginSource: './plugins/code-reviewer',
      },
      packageType: 'shape',
      requestedMarketplace: 'something-else',
      outcome: 'success',
      durationMs: 12,
    });
    expect(event).toMatchObject({
      packageName: 'code-reviewer',
      marketplace: 'dorkos-community',
      type: 'shape',
      sourceType: 'relative-path',
    });
  });
});
