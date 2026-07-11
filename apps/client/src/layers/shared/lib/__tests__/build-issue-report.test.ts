import { describe, it, expect } from 'vitest';
import type { ServerConfig } from '@dorkos/shared/schemas';
import { buildClientReport } from '../build-issue-report';

/** A server config with sensitive values in the fields we must never report. */
function configWithSecrets(): ServerConfig {
  return {
    version: '0.45.1',
    latestVersion: null,
    isDevMode: false,
    dismissedUpgradeVersions: [],
    port: 4242,
    uptime: 100,
    workingDirectory: '/Users/dorian/private-project',
    nodeVersion: 'v22.10.0',
    platform: 'darwin-arm64',
    runtimes: ['claude-code', 'codex'],
    claudeCliPath: '/Users/dorian/.local/bin/claude',
    tunnel: {
      enabled: true,
      connected: true,
      url: 'https://secret.ngrok.app',
      port: 4242,
      startedAt: null,
      authEnabled: true,
      tokenConfigured: true,
      domain: 'secret.ngrok.app',
    },
    tasks: { enabled: true },
    relay: { enabled: false },
    logging: { level: 'info', maxLogSizeKb: 500, maxLogFiles: 14 },
    mesh: { enabled: true },
    telemetry: { enabled: false, userHasDecided: true },
    auth: { enabled: true },
  } as unknown as ServerConfig;
}

describe('buildClientReport', () => {
  it('captures version, platform, runtimes, and the route as surface', () => {
    const report = buildClientReport('bug', configWithSecrets(), '/agents');
    expect(report.version).toBe('0.45.1');
    expect(report.platform).toBe('darwin-arm64');
    expect(report.runtimes).toEqual(['claude-code', 'codex']);
    expect(report.surface).toBe('web /agents');
  });

  it('reports only safe on/off flags, never paths, tokens, or URLs', () => {
    const report = buildClientReport('bug', configWithSecrets(), '/agents');
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain('/Users/dorian');
    expect(serialized).not.toContain('ngrok.app');
    expect(serialized).not.toContain('private-project');
    // Safe flags survive.
    expect(report.flags['tunnel.enabled']).toBe(true);
    expect(report.flags['tasks.enabled']).toBe(true);
    expect(report.flags['logging.level']).toBe('info');
  });

  it('degrades to unknowns when config is still loading', () => {
    const report = buildClientReport('feature', undefined, '/tasks');
    expect(report.version).toBe('unknown');
    expect(report.platform).toBe('unknown');
    expect(report.runtimes).toEqual([]);
    expect(report.flags).toEqual({});
  });
});
