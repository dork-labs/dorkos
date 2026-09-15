/** @vitest-environment node */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildIssueUrl,
  gatherFeedbackReport,
  FEEDBACK_ISSUES_NEW_URL,
} from '@dorkos/shared/feedback';
import { gatherCliReport, runFeedback, type FeedbackDeps } from '../feedback.js';
import { initConfigManager } from '../../../server/services/core/config-manager.js';
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

/**
 * The CLI half of the `feedback_draft` parity chain (DOR-2056).
 *
 * An agent that hands someone a link and says "this is what `dorkos feedback`
 * would have given you" has to be telling the truth, and the only way to keep it
 * true is one code path. These pin this end of it: the printed URL is
 * `buildIssueUrl(gatherCliReport(…))`, and `gatherCliReport` is the shared
 * `gatherFeedbackReport` with `surface: 'cli'` rather than a second gatherer
 * that agrees today. The other two links are pinned in
 * `packages/shared/src/__tests__/feedback.test.ts` (two surfaces over one host
 * differ by exactly one line) and
 * `apps/server/src/services/core/operator/__tests__/feedback-draft.test.ts` (the
 * capability is the `surface: 'agent'` end). No single test can span the two
 * packages: the server may not import the CLI.
 */
describe('dorkos feedback and the feedback_draft capability build one URL', () => {
  it('gathers through the shared gatherer, not a copy of it', () => {
    const values = {
      'tunnel.enabled': false,
      'logging.level': 'info',
      'runtimes.opencode.enabled': false,
      // Off the allowlist: it must not survive either path.
      'tunnel.authtoken': 'ngrok-secret-token',
    };

    expect(gatherCliReport('bug', '0.45.1', fakeStore(values))).toEqual(
      gatherFeedbackReport({
        kind: 'bug',
        version: '0.45.1',
        platform: `${os.platform()}-${os.arch()}`,
        surface: 'cli',
        readConfigValue: (key) => values[key as keyof typeof values],
      })
    );
  });

  it('prints exactly the URL that gatherer builds, over the real config on disk', async () => {
    const dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-cli-feedback-'));
    try {
      // Written before the command runs, and read back through the same store
      // the command will open, so this proves the printed URL reflects the
      // config on disk rather than a default the two happen to share.
      const configManager = initConfigManager(dorkHome);
      configManager.set('logging', { ...configManager.get('logging'), level: 'debug' });
      const store = configManager as unknown as ConfigStore;

      const deps = captureDeps();
      await runFeedback(dorkHome, '0.45.1', ['--print'], deps);
      const printed = deps.lines.find((line) => line.trim().startsWith(FEEDBACK_ISSUES_NEW_URL));

      expect(printed?.trim()).toBe(buildIssueUrl(gatherCliReport('bug', '0.45.1', store)));
      expect(new URL(printed!.trim()).searchParams.get('body')?.split('\n')).toContain(
        '- logging.level: debug'
      );
    } finally {
      fs.rmSync(dorkHome, { recursive: true, force: true });
    }
  });
});
