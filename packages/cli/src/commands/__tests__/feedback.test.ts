/** @vitest-environment node */
import { describe, it, expect, vi } from 'vitest';
import { gatherCliReport, runFeedback, type FeedbackDeps } from '../feedback.js';
import type { ConfigStore } from '../../config-commands.js';

/** A minimal fake config store backed by a dotted-key map. */
function fakeStore(values: Record<string, unknown>): ConfigStore {
  return {
    getDot: (key: string) => values[key],
  } as unknown as ConfigStore;
}

/** Capture logged lines and the opened URL for assertions. */
function captureDeps(): FeedbackDeps & { lines: string[]; openedUrl: string | null } {
  const lines: string[] = [];
  let openedUrl: string | null = null;
  return {
    lines,
    get openedUrl() {
      return openedUrl;
    },
    log: (message: string) => lines.push(message),
    openUrl: (url: string) => {
      openedUrl = url;
      return true;
    },
  };
}

describe('gatherCliReport', () => {
  it('reports version, platform, runtimes, and sanitized flags', () => {
    const store = fakeStore({
      'tunnel.enabled': false,
      'scheduler.enabled': true,
      'logging.level': 'info',
      'runtimes.codex.enabled': true,
      'runtimes.opencode.enabled': false,
    });
    const report = gatherCliReport('bug', '0.45.1', store);

    expect(report.kind).toBe('bug');
    expect(report.version).toBe('0.45.1');
    expect(report.surface).toBe('cli');
    expect(report.platform).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(report.runtimes).toContain('claude-code');
    expect(report.runtimes).toContain('codex');
    expect(report.runtimes).not.toContain('opencode');
    expect(report.flags['tunnel.enabled']).toBe(false);
    expect(report.flags['logging.level']).toBe('info');
  });

  it('never carries a secret or path into the flags', () => {
    const store = fakeStore({
      'tunnel.authtoken': 'ngrok-secret',
      'mcp.apiKey': 'sk-live-123',
      'server.cwd': '/Users/dorian/private',
      'tunnel.enabled': true,
    });
    const report = gatherCliReport('bug', '0.45.1', store);
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain('ngrok-secret');
    expect(serialized).not.toContain('sk-live-123');
    expect(serialized).not.toContain('/Users/dorian');
    expect(report.flags['tunnel.enabled']).toBe(true);
  });

  it('degrades to defaults when there is no config store', () => {
    const report = gatherCliReport('feature', '0.45.1', null);
    expect(report.runtimes).toEqual(['claude-code', 'codex', 'opencode']);
    expect(report.flags).toEqual({});
  });
});

describe('runFeedback', () => {
  it('opens a prefilled GitHub issue URL', async () => {
    const deps = captureDeps();
    const code = await runFeedback('/tmp/dork', '0.45.1', [], deps);

    expect(code).toBe(0);
    expect(deps.openedUrl).toContain('https://github.com/dork-labs/dorkos/issues/new');
    expect(deps.openedUrl).toContain('labels=bug');
  });

  it('prints the URL instead of opening with --print', async () => {
    const deps = captureDeps();
    const openSpy = vi.spyOn(deps, 'openUrl');
    const code = await runFeedback('/tmp/dork', '0.45.1', ['--print'], deps);

    expect(code).toBe(0);
    expect(openSpy).not.toHaveBeenCalled();
    expect(deps.lines.some((l) => l.includes('/dork-labs/dorkos/issues/new'))).toBe(true);
  });

  it('selects the feature template with --feature', async () => {
    const deps = captureDeps();
    await runFeedback('/tmp/dork', '0.45.1', ['--feature', '--print'], deps);
    expect(deps.lines.some((l) => l.includes('labels=enhancement'))).toBe(true);
  });

  it('shows help with --help', async () => {
    const deps = captureDeps();
    const code = await runFeedback('/tmp/dork', '0.45.1', ['--help'], deps);
    expect(code).toBe(0);
    expect(deps.lines.join('\n')).toContain('Usage: dorkos feedback');
  });
});
