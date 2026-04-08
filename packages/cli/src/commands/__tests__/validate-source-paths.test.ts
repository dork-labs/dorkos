import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  checkSourcePaths,
  localProbe,
  remoteProbe,
  makeLocalCandidateBuilder,
  makeRemoteCandidateBuilder,
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

const allRelativeUnderPlugins = parseMarketplace({
  name: 'dorkos',
  owner: { name: 'Dork Labs' },
  metadata: { pluginRoot: './plugins' },
  plugins: [
    { name: 'code-reviewer', source: './plugins/code-reviewer' },
    { name: 'security-auditor', source: './plugins/security-auditor' },
  ],
});

const brokenExplicitDotSlash = parseMarketplace({
  name: 'dorkos',
  owner: { name: 'Dork Labs' },
  metadata: { pluginRoot: './plugins' },
  plugins: [
    { name: 'code-reviewer', source: './code-reviewer' },
    { name: 'security-auditor', source: './security-auditor' },
  ],
});

const mixedObjectAndRelative = parseMarketplace({
  name: 'dorkos',
  owner: { name: 'Dork Labs' },
  metadata: { pluginRoot: './plugins' },
  plugins: [
    { name: 'code-reviewer', source: './plugins/code-reviewer' },
    { name: 'remote-plugin', source: { source: 'github', repo: 'acme/plugin' } },
  ],
});

const allObjectSources = parseMarketplace({
  name: 'dorkos',
  owner: { name: 'Dork Labs' },
  plugins: [
    { name: 'code-reviewer', source: { source: 'github', repo: 'dork-labs/code-reviewer' } },
    { name: 'docs-keeper', source: { source: 'github', repo: 'dork-labs/docs-keeper' } },
  ],
});

const bareNameNoPluginRoot = parseMarketplace({
  name: 'dorkos',
  owner: { name: 'Dork Labs' },
  plugins: [{ name: 'solo', source: './solo' }],
});

// -------- checkSourcePaths --------

describe('checkSourcePaths', () => {
  it('returns ok when every relative-path source is reachable', async () => {
    const probe = vi.fn(async () => true);
    const builder = makeLocalCandidateBuilder('/mp');

    const report = await checkSourcePaths(allRelativeUnderPlugins, probe, builder, '/mp');

    expect(report.ok).toBe(true);
    expect(report.checkedCount).toBe(2);
    expect(report.totalCount).toBe(2);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(report.results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('flags entries whose probed candidates do not exist', async () => {
    const probe = vi.fn(async () => false);
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
    const probe = vi.fn(async () => true);
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

  it('resolves sources via resolvePluginSource (pluginRoot applied for correct sources)', async () => {
    const probe = vi.fn(async () => true);
    const seen: string[] = [];
    const builder = (resolved: string) => {
      seen.push(resolved);
      return `/mp/${resolved}`;
    };

    await checkSourcePaths(allRelativeUnderPlugins, probe, builder, '/mp');

    expect(seen).toEqual(['plugins/code-reviewer', 'plugins/security-auditor']);
  });

  it('skips object-form sources without calling the probe', async () => {
    const probe = vi.fn(async () => true);
    const report = await checkSourcePaths(
      allObjectSources,
      probe,
      makeLocalCandidateBuilder('/mp'),
      '/mp'
    );

    expect(report.ok).toBe(true);
    expect(report.checkedCount).toBe(0);
    expect(report.totalCount).toBe(2);
    expect(probe).not.toHaveBeenCalled();
    expect(report.results).toEqual([
      { name: 'code-reviewer', status: 'skipped-object-source' },
      { name: 'docs-keeper', status: 'skipped-object-source' },
    ]);
  });

  it('handles mixed relative + object sources in a single marketplace', async () => {
    const probe = vi.fn(async () => true);
    const report = await checkSourcePaths(
      mixedObjectAndRelative,
      probe,
      makeLocalCandidateBuilder('/mp'),
      '/mp'
    );

    expect(report.ok).toBe(true);
    expect(report.checkedCount).toBe(1);
    expect(report.totalCount).toBe(2);
    expect(probe).toHaveBeenCalledTimes(1);
    const statuses = report.results.map((r) => r.status);
    expect(statuses).toContain('ok');
    expect(statuses).toContain('skipped-object-source');
  });

  it('runs probes in parallel (Promise.all)', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const probe = vi.fn(async (candidate: string) => {
      started.push(candidate);
      await gate;
      return true;
    });

    const promise = checkSourcePaths(
      allRelativeUnderPlugins,
      probe,
      makeLocalCandidateBuilder('/mp'),
      '/mp'
    );
    await new Promise((r) => setTimeout(r, 10));

    // Both probes started before either resolved.
    expect(started).toHaveLength(2);
    release();
    await promise;
  });

  it('checks bare-name sources when pluginRoot is absent', async () => {
    const probe = vi.fn(async () => true);
    const seen: string[] = [];
    const builder = (resolved: string) => {
      seen.push(resolved);
      return `/mp/${resolved}`;
    };

    await checkSourcePaths(bareNameNoPluginRoot, probe, builder, '/mp');

    // './solo' strips to 'solo' since pluginRoot is undefined.
    expect(seen).toEqual(['solo']);
  });
});

// -------- makeLocalCandidateBuilder / makeRemoteCandidateBuilder --------

describe('makeLocalCandidateBuilder', () => {
  it('joins marketplaceRoot + resolvedPath + .claude-plugin/plugin.json', () => {
    const build = makeLocalCandidateBuilder('/abs/mp');
    expect(build('plugins/code-reviewer')).toBe(
      '/abs/mp/plugins/code-reviewer/.claude-plugin/plugin.json'
    );
  });
});

describe('makeRemoteCandidateBuilder', () => {
  it('joins base URL + resolvedPath + .claude-plugin/plugin.json', () => {
    const build = makeRemoteCandidateBuilder('https://github.com/dork-labs/marketplace/raw/main');
    expect(build('plugins/code-reviewer')).toBe(
      'https://github.com/dork-labs/marketplace/raw/main/plugins/code-reviewer/.claude-plugin/plugin.json'
    );
  });

  it('normalizes trailing slashes on rawBase', () => {
    const build = makeRemoteCandidateBuilder(
      'https://github.com/dork-labs/marketplace/raw/main///'
    );
    expect(build('a')).toBe(
      'https://github.com/dork-labs/marketplace/raw/main/a/.claude-plugin/plugin.json'
    );
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

  it('returns true when the file exists', async () => {
    const file = path.join(tmpRoot, 'plugin.json');
    fs.writeFileSync(file, '{}');
    expect(await localProbe(file)).toBe(true);
  });

  it('returns false for a missing file', async () => {
    expect(await localProbe(path.join(tmpRoot, 'missing.json'))).toBe(false);
  });

  it('returns false when the path is a directory', async () => {
    expect(await localProbe(tmpRoot)).toBe(false);
  });
});

// -------- remoteProbe --------

describe('remoteProbe', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns true on a 2xx response', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    expect(await remoteProbe('https://example.com/p.json')).toBe(true);
  });

  it('returns false on a 404 response', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    expect(await remoteProbe('https://example.com/p.json')).toBe(false);
  });

  it('returns false when fetch throws (network error)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await remoteProbe('https://example.com/p.json')).toBe(false);
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

  it('renders a plain [OK] line when every source passes', () => {
    const results: SourcePathCheckResult[] = [
      { name: 'a', status: 'ok', candidate: '/mp/a/.claude-plugin/plugin.json' },
      { name: 'b', status: 'ok', candidate: '/mp/b/.claude-plugin/plugin.json' },
    ];
    const { okLine, failBlock } = renderSourcePathResults(
      mkReport({ ok: true, results, checkedCount: 2, totalCount: 2 }),
      allRelativeUnderPlugins
    );
    expect(okLine).toBe('[OK]   Plugin sources reachable (2/2)\n');
    expect(failBlock).toBe('');
  });

  it('annotates the [OK] line when some entries were skipped as object-form', () => {
    const results: SourcePathCheckResult[] = [
      { name: 'a', status: 'ok', candidate: '/mp/a/.claude-plugin/plugin.json' },
      { name: 'b', status: 'skipped-object-source' },
    ];
    const { okLine } = renderSourcePathResults(
      mkReport({ ok: true, results, checkedCount: 1, totalCount: 2 }),
      mixedObjectAndRelative
    );
    expect(okLine).toBe(
      '[OK]   Plugin sources reachable (1/1 relative-path, 1 object-form skipped)\n'
    );
  });

  it('renders a "no relative-path sources to verify" note when every entry is object-form', () => {
    const results: SourcePathCheckResult[] = [
      { name: 'a', status: 'skipped-object-source' },
      { name: 'b', status: 'skipped-object-source' },
    ];
    const { okLine } = renderSourcePathResults(
      mkReport({ ok: true, results, checkedCount: 0, totalCount: 2 }),
      allObjectSources
    );
    expect(okLine).toBe('[OK]   Plugin sources reachable (no relative-path sources to verify)\n');
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

  it('omits the pluginRoot hint when pluginRoot is absent', () => {
    const results: SourcePathCheckResult[] = [
      {
        name: 'solo',
        status: 'not-found',
        candidate: '/mp/solo/.claude-plugin/plugin.json',
        sourceInput: './solo',
      },
    ];
    const { failBlock } = renderSourcePathResults(
      mkReport({ ok: false, results, checkedCount: 1, totalCount: 1 }),
      bareNameNoPluginRoot
    );
    expect(failBlock).not.toContain('IGNORES pluginRoot');
  });
});
