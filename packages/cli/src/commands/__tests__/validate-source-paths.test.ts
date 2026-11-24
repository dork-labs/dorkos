import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  checkSourcePaths,
  localProbe,
  makeLocalCandidateBuilder,
  renderSourcePathResults,
  type SourcePathCheckReport,
  type SourcePathCheckResult,
} from '../validate-source-paths.js';
import { parseMarketplaceJson } from '@dorkos/marketplace';

// -------- Fixtures --------

function parseMarketplace(payload: unknown) {
  const result = parseMarketplaceJson(JSON.stringify(payload));
  if (!result.ok) throw new Error(`fixture parse failed: ${result.error}`);
  return result.marketplace;
}

const brokenExplicitDotSlash = parseMarketplace({
  name: 'dorkos',
  owner: { name: 'Dork Labs' },
  metadata: { pluginRoot: './plugins' },
  plugins: [
    { name: 'code-reviewer', source: './code-reviewer' },
    { name: 'security-auditor', source: './security-auditor' },
  ],
});

// -------- checkSourcePaths --------

describe('checkSourcePaths', () => {
  it('flags entries whose probed candidates do not exist', async () => {
    const probe = vi.fn(async () => ({ reachable: false }));
    const builder = makeLocalCandidateBuilder('/mp');

    const report = await checkSourcePaths(brokenExplicitDotSlash, probe, builder, '/mp');

    expect(report.ok).toBe(false);
    expect(report.checkedCount).toBe(2);
    expect(report.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'code-reviewer',
          status: 'not-found',
          sourceInput: './code-reviewer',
        }),
      ])
    );
  });

  it('resolves sources via resolvePluginSource (pluginRoot ignored when source starts with ./)', async () => {
    const probe = vi.fn(async () => ({ reachable: true }));
    const seen: string[] = [];
    const builder = (resolved: string) => {
      seen.push(resolved);
      return `/mp/${resolved}/.claude-plugin/plugin.json`;
    };

    await checkSourcePaths(brokenExplicitDotSlash, probe, builder, '/mp');

    // pluginRoot was `./plugins` but sources have explicit `./` so
    // pluginRoot is silently ignored — the resolved paths lose the
    // `plugins/` prefix. This is the exact bug the check is here to
    // surface downstream.
    expect(seen).toEqual(['code-reviewer', 'security-auditor']);
  });
});

// -------- makeLocalCandidateBuilder / makeRemoteCandidateBuilder --------

describe('checkSourcePaths — entry version vs plugin.json (ENTRY_VERSION_MISMATCH)', () => {
  /** A one-entry marketplace whose entry sets `version` when given. */
  function withEntryVersion(version?: string) {
    return parseMarketplace({
      name: 'dorkos',
      owner: { name: 'Dork Labs' },
      plugins: [
        {
          name: 'code-reviewer',
          source: './plugins/code-reviewer',
          ...(version !== undefined && { version }),
        },
      ],
    });
  }

  it("fails when the entry's version differs from plugin.json's", async () => {
    // Purpose: Claude Code silently uses plugin.json's version, so the
    // entry's is never seen — a publish-time mistake worth refusing.
    const report = await checkSourcePaths(
      withEntryVersion('1.0.0'),
      vi.fn(async () => ({ reachable: true, version: '1.1.0' })),
      makeLocalCandidateBuilder('/mp'),
      '/mp'
    );

    expect(report.ok).toBe(false);
    expect(report.results[0]).toEqual({
      name: 'code-reviewer',
      status: 'version-mismatch',
      candidate: '/mp/plugins/code-reviewer/.claude-plugin/plugin.json',
      entryVersion: '1.0.0',
      pluginVersion: '1.1.0',
    });
    const rendered = renderSourcePathResults(report, withEntryVersion('1.0.0'));
    // Its own heading: every source WAS reachable, so the reachability line
    // would misdescribe the failure.
    expect(rendered.failBlock).toContain('[FAIL] Entry versions match plugin.json');
    expect(rendered.failBlock).not.toContain('Plugin sources reachable');
    expect(rendered.failBlock).toContain(
      'code-reviewer: ENTRY_VERSION_MISMATCH: marketplace.json says version 1.0.0 but ' +
        '/mp/plugins/code-reviewer/.claude-plugin/plugin.json says 1.1.0.'
    );
    expect(rendered.failBlock).toContain("Claude Code silently uses plugin.json's version");
  });

  it('still skips object-form entries, whatever version they set', async () => {
    // Purpose: checking them would clone foreign repos during validation.
    const marketplace = parseMarketplace({
      name: 'dorkos',
      owner: { name: 'Dork Labs' },
      plugins: [{ name: 'remote', source: { source: 'github', repo: 'acme/p' }, version: '9.9.9' }],
    });
    const probe = vi.fn(async () => ({ reachable: true, version: '1.0.0' }));

    const report = await checkSourcePaths(
      marketplace,
      probe,
      makeLocalCandidateBuilder('/mp'),
      '/mp'
    );

    expect(report.ok).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});

// -------- localProbe --------

describe('localProbe', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `validate-source-paths-${randomUUID()}-`));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reports a missing file as unreachable', async () => {
    expect(await localProbe(path.join(tmpRoot, 'missing.json'))).toEqual({ reachable: false });
  });
});

// -------- renderSourcePathResults --------

describe('renderSourcePathResults', () => {
  const mkReport = (overrides: Partial<SourcePathCheckReport> = {}): SourcePathCheckReport => ({
    ok: true,
    results: [],
    checkedCount: 0,
    totalCount: 0,
    ...overrides,
  });

  it('emits a [FAIL] block with per-entry details on failure', () => {
    const results: SourcePathCheckResult[] = [
      {
        name: 'code-reviewer',
        status: 'not-found',
        candidate: '/mp/code-reviewer/.claude-plugin/plugin.json',
        sourceInput: './code-reviewer',
      },
      {
        name: 'security-auditor',
        status: 'not-found',
        candidate: '/mp/security-auditor/.claude-plugin/plugin.json',
        sourceInput: './security-auditor',
      },
    ];
    const { okLine, failBlock } = renderSourcePathResults(
      mkReport({ ok: false, results, checkedCount: 2, totalCount: 2 }),
      brokenExplicitDotSlash
    );
    expect(okLine).toBe('');
    expect(failBlock).toContain('[FAIL] Plugin sources reachable (0/2)');
    expect(failBlock).toContain('code-reviewer: "./code-reviewer"');
    expect(failBlock).toContain('security-auditor: "./security-auditor"');
  });

  it('appends the pluginRoot hint when pluginRoot is set and failures use explicit ./', () => {
    const results: SourcePathCheckResult[] = [
      {
        name: 'code-reviewer',
        status: 'not-found',
        candidate: '/mp/code-reviewer/.claude-plugin/plugin.json',
        sourceInput: './code-reviewer',
      },
    ];
    const { failBlock } = renderSourcePathResults(
      mkReport({ ok: false, results, checkedCount: 1, totalCount: 1 }),
      brokenExplicitDotSlash
    );
    expect(failBlock).toContain('CC 2.1.92 IGNORES pluginRoot');
    expect(failBlock).toContain('"./plugins/<name>"');
  });
});
