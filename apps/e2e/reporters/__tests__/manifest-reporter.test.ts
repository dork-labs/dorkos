import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FullConfig, FullProject, TestCase, TestResult } from '@playwright/test/reporter';
import ManifestReporter, {
  isFullSuiteRun,
  REFRESH_MANIFEST_ENV_VAR,
} from '../manifest-reporter.js';

/**
 * Unit tests for `manifest-reporter.ts` — the custom Playwright reporter that
 * keeps `apps/e2e/manifest.json` in sync with the suite.
 *
 * DOR-1555: an existing entry's `description` was only ever set once, at
 * creation, so a renamed test kept its old, now-misleading description
 * forever. These tests pin the fix and the hardening an adversarial review
 * found on top of it:
 * - `description` only refreshes when the operator opted in via
 *   {@link REFRESH_MANIFEST_ENV_VAR} AND `FullConfig` looks unfiltered
 *   (top-level AND per-project grep/grepInvert, AND no shard) — the opt-in is
 *   the primary gate because `FullConfig` alone cannot see every filter this
 *   repo's own `playwright.config.ts` applies (project-level `grepInvert`).
 * - `--repeat-each=N` reports one `onTestEnd` per attempt with the same
 *   title; the description must dedupe, not repeat.
 * - `specFile`/`feature` are per-file facts and refresh unconditionally, with
 *   no full-suite gate, so a moved spec is never misreported as orphaned.
 *
 * @module reporters/__tests__/manifest-reporter
 */

/** Absolute path to `apps/e2e/tests`, matching what the reporter itself resolves `test.location.file` against. */
const TESTS_DIR = path.resolve(import.meta.dirname, '..', '..', 'tests');

/** A default, fully-permissive `FullProject` fragment — grep left at Playwright's own default, no invert. */
function fakeProject(
  overrides: Partial<Pick<FullProject, 'grep' | 'grepInvert'>> = {}
): FullProject {
  return {
    grep: /.*/,
    grepInvert: null,
    ...overrides,
  } as unknown as FullProject;
}

/** A `FullConfig` slice with the fields `isFullSuiteRun`/`onBegin` read, defaulting to "nothing filtered anywhere." */
function fakeConfig(
  overrides: Partial<Pick<FullConfig, 'grep' | 'grepInvert' | 'shard' | 'projects'>> = {}
): FullConfig {
  return {
    grep: /.*/,
    grepInvert: null,
    shard: null,
    projects: [fakeProject()],
    ...overrides,
  } as unknown as FullConfig;
}

/** A minimal `TestCase` — only `title` and `location.file` are read by the reporter. */
function fakeTestCase(title: string, relativeFile: string): TestCase {
  return {
    title,
    location: { file: path.join(TESTS_DIR, relativeFile) },
  } as unknown as TestCase;
}

/** A minimal `TestResult` — only `status`/`duration` are read by the reporter. */
function fakeTestResult(status: 'passed' | 'failed' | 'skipped'): TestResult {
  return { status, duration: 5 } as unknown as TestResult;
}

describe('manifest-reporter', () => {
  let manifestPath: string;
  let envBefore: string | undefined;

  beforeEach(() => {
    manifestPath = path.join(
      os.tmpdir(),
      `manifest-reporter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    // Every test starts opted OUT — individual tests opt in explicitly so the
    // default reflects what an ordinary, unconfigured run gets.
    envBefore = process.env[REFRESH_MANIFEST_ENV_VAR];
    delete process.env[REFRESH_MANIFEST_ENV_VAR];
  });

  afterEach(() => {
    fs.rmSync(manifestPath, { force: true });
    if (envBefore === undefined) delete process.env[REFRESH_MANIFEST_ENV_VAR];
    else process.env[REFRESH_MANIFEST_ENV_VAR] = envBefore;
  });

  /** Seeds the scratch manifest file with one hand-authored existing entry. */
  function seedManifest(overrides: Record<string, unknown> = {}): void {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          tests: {
            'rename-test': {
              specFile: 'tests/chat/rename-test.spec.ts',
              feature: 'chat',
              description: 'shows the old, pre-rename behavior',
              lastRun: '2026-01-01T00:00:00.000Z',
              lastStatus: 'passed',
              runCount: 3,
              passCount: 3,
              failCount: 0,
              relatedCode: ['apps/client/src/some-file.ts'],
              explorationNotes: ['a curated note from a human'],
              lastModified: '',
              ...overrides,
            },
          },
          runHistory: [],
        },
        null,
        2
      )
    );
  }

  function readManifest() {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  }

  describe('isFullSuiteRun', () => {
    it('is true with no grep/grepInvert/shard filtering anywhere', () => {
      expect(isFullSuiteRun(fakeConfig())).toBe(true);
    });

    it('is false when top-level --grep narrowed the run', () => {
      expect(isFullSuiteRun(fakeConfig({ grep: /rename/ }))).toBe(false);
    });

    it('is false when top-level --grep-invert was used', () => {
      expect(isFullSuiteRun(fakeConfig({ grepInvert: /skip-me/ }))).toBe(false);
    });

    it('is false when --shard split the suite', () => {
      expect(isFullSuiteRun(fakeConfig({ shard: { total: 3, current: 1 } }))).toBe(false);
    });

    it("is false when a PROJECT carries a standing grepInvert (this repo's own @integration exclusion)", () => {
      // Mirrors apps/e2e/playwright.config.ts: the default chromium project
      // sets `grepInvert: /@integration/` unless INCLUDE_INTEGRATION is set.
      // Top-level grep/grepInvert stay at Playwright's defaults throughout —
      // an ordinary local run never touches them — so this filter is
      // invisible unless config.projects is inspected too.
      expect(
        isFullSuiteRun(fakeConfig({ projects: [fakeProject({ grepInvert: /@integration/ })] }))
      ).toBe(false);
    });

    it('is false when a PROJECT carries a standing grep', () => {
      expect(isFullSuiteRun(fakeConfig({ projects: [fakeProject({ grep: /@smoke/ })] }))).toBe(
        false
      );
    });
  });

  it("(a) refreshes a renamed test's description on a full run with the opt-in env set", () => {
    seedManifest();
    process.env[REFRESH_MANIFEST_ENV_VAR] = '1';
    const reporter = new ManifestReporter({ manifestPath });
    reporter.onBegin(fakeConfig());
    reporter.onTestEnd(
      fakeTestCase('shows the new, renamed behavior', 'chat/rename-test.spec.ts'),
      fakeTestResult('passed')
    );
    reporter.onEnd(undefined as never);

    const entry = readManifest().tests['rename-test'];
    expect(entry.description).toBe('shows the new, renamed behavior');
    // Curated/derived fields untouched by the refresh.
    expect(entry.relatedCode).toEqual(['apps/client/src/some-file.ts']);
    expect(entry.explorationNotes).toEqual(['a curated note from a human']);
  });

  it('(a-neg) does NOT refresh a full-looking run when the opt-in env is unset', () => {
    // Config alone looks completely unfiltered — the same fakeConfig() as the
    // (a) test above — but nothing set E2E_REFRESH_MANIFEST, so the primary
    // gate refuses. This is the "everything not opted in fails closed" case
    // the review specifically asked to pin.
    seedManifest();
    const reporter = new ManifestReporter({ manifestPath });
    reporter.onBegin(fakeConfig());
    reporter.onTestEnd(
      fakeTestCase('shows the new, renamed behavior', 'chat/rename-test.spec.ts'),
      fakeTestResult('passed')
    );
    reporter.onEnd(undefined as never);

    expect(readManifest().tests['rename-test'].description).toBe(
      'shows the old, pre-rename behavior'
    );
  });

  it('(a-neg) does NOT refresh when opted in but a project-level filter is active', () => {
    // The opt-in alone is not sufficient — it is AND-ed with isFullSuiteRun,
    // which this project-level grepInvert should fail.
    seedManifest();
    process.env[REFRESH_MANIFEST_ENV_VAR] = '1';
    const reporter = new ManifestReporter({ manifestPath });
    reporter.onBegin(fakeConfig({ projects: [fakeProject({ grepInvert: /@integration/ })] }));
    reporter.onTestEnd(
      fakeTestCase('shows the new, renamed behavior', 'chat/rename-test.spec.ts'),
      fakeTestResult('passed')
    );
    reporter.onEnd(undefined as never);

    expect(readManifest().tests['rename-test'].description).toBe(
      'shows the old, pre-rename behavior'
    );
  });

  it('(b) does not clobber the description on a -g filtered subset run, even opted in', () => {
    seedManifest();
    process.env[REFRESH_MANIFEST_ENV_VAR] = '1';
    const reporter = new ManifestReporter({ manifestPath });
    // A -g run that only matched ONE of the file's tests: FullConfig.grep is
    // no longer the default catch-all.
    reporter.onBegin(fakeConfig({ grep: /new/ }));
    reporter.onTestEnd(
      fakeTestCase('shows the new, renamed behavior', 'chat/rename-test.spec.ts'),
      fakeTestResult('passed')
    );
    reporter.onEnd(undefined as never);

    const entry = readManifest().tests['rename-test'];
    expect(entry.description).toBe('shows the old, pre-rename behavior');
  });

  it('(b) does not clobber the description on a sharded run, even opted in', () => {
    seedManifest();
    process.env[REFRESH_MANIFEST_ENV_VAR] = '1';
    const reporter = new ManifestReporter({ manifestPath });
    reporter.onBegin(fakeConfig({ shard: { total: 3, current: 2 } }));
    reporter.onTestEnd(
      fakeTestCase('shows the new, renamed behavior', 'chat/rename-test.spec.ts'),
      fakeTestResult('passed')
    );
    reporter.onEnd(undefined as never);

    const entry = readManifest().tests['rename-test'];
    expect(entry.description).toBe('shows the old, pre-rename behavior');
  });

  it('(c) accumulates runCount/passCount/failCount on a full, opted-in run', () => {
    seedManifest();
    process.env[REFRESH_MANIFEST_ENV_VAR] = '1';
    const reporter = new ManifestReporter({ manifestPath });
    reporter.onBegin(fakeConfig());
    reporter.onTestEnd(
      fakeTestCase('shows the new, renamed behavior', 'chat/rename-test.spec.ts'),
      fakeTestResult('passed')
    );
    reporter.onEnd(undefined as never);

    const entry = readManifest().tests['rename-test'];
    expect(entry.runCount).toBe(4);
    expect(entry.passCount).toBe(4);
    expect(entry.failCount).toBe(0);
    expect(entry.lastStatus).toBe('passed');
  });

  it('(c) accumulates runCount/passCount/failCount on an un-opted-in subset run too', () => {
    seedManifest();
    const reporter = new ManifestReporter({ manifestPath });
    reporter.onBegin(fakeConfig({ grep: /new/ }));
    reporter.onTestEnd(
      fakeTestCase('shows the new, renamed behavior', 'chat/rename-test.spec.ts'),
      fakeTestResult('failed')
    );
    reporter.onEnd(undefined as never);

    const entry = readManifest().tests['rename-test'];
    expect(entry.runCount).toBe(4);
    expect(entry.passCount).toBe(3);
    expect(entry.failCount).toBe(1);
    expect(entry.lastStatus).toBe('failed');
  });

  it('dedupes titles from --repeat-each attempts instead of repeating them in the description', () => {
    // --repeat-each=N reports one onTestEnd per ATTEMPT with the identical
    // title, and touches none of grep/grepInvert/shard/projects — so a full,
    // opted-in run of a repeated test must not turn "renders the app shell"
    // into "renders the app shell, renders the app shell, renders the app
    // shell".
    seedManifest();
    process.env[REFRESH_MANIFEST_ENV_VAR] = '1';
    const reporter = new ManifestReporter({ manifestPath });
    reporter.onBegin(fakeConfig());
    for (let i = 0; i < 3; i++) {
      reporter.onTestEnd(
        fakeTestCase('shows the new, renamed behavior', 'chat/rename-test.spec.ts'),
        fakeTestResult('passed')
      );
    }
    reporter.onEnd(undefined as never);

    expect(readManifest().tests['rename-test'].description).toBe('shows the new, renamed behavior');
  });

  it('refreshes specFile/feature unconditionally when a spec moves directories, even on an un-opted-in subset run', () => {
    // The seeded entry claims the file still lives under chat/, but this run
    // saw it at streams/ — no full-suite gate should block correcting that,
    // because it is a fact about THIS run's own file, not an aggregate over
    // titles this run didn't see. Left stale, /browsertest:maintain would
    // glob the OLD specFile, find nothing, and offer to delete the live test.
    seedManifest();
    const reporter = new ManifestReporter({ manifestPath });
    // Deliberately un-opted-in AND filtered (-g), to prove specFile/feature
    // refresh needs neither.
    reporter.onBegin(fakeConfig({ grep: /new/ }));
    reporter.onTestEnd(
      fakeTestCase('shows the new, renamed behavior', 'streams/rename-test.spec.ts'),
      fakeTestResult('passed')
    );
    reporter.onEnd(undefined as never);

    const entry = readManifest().tests['rename-test'];
    expect(entry.specFile).toBe('tests/streams/rename-test.spec.ts');
    expect(entry.feature).toBe('streams');
    // The description, in contrast, stays untouched by the same run.
    expect(entry.description).toBe('shows the old, pre-rename behavior');
  });

  it("seeds a brand-new entry's description even on an un-opted-in subset run", () => {
    // No seedManifest() — the file starts with no manifest.json at all, so
    // loadManifest() falls back to an empty registry.
    const reporter = new ManifestReporter({ manifestPath });
    reporter.onBegin(fakeConfig({ grep: /only-one/ }));
    reporter.onTestEnd(
      fakeTestCase('only-one matching title', 'chat/brand-new.spec.ts'),
      fakeTestResult('passed')
    );
    reporter.onEnd(undefined as never);

    const entry = readManifest().tests['brand-new'];
    expect(entry.description).toBe('only-one matching title');
    expect(entry.specFile).toBe('tests/chat/brand-new.spec.ts');
    expect(entry.feature).toBe('chat');
    expect(entry.runCount).toBe(1);
  });

  it('does not write the manifest file at all when no test ran (--list / a -g that matched nothing)', () => {
    seedManifest();
    const before = fs.statSync(manifestPath).mtimeMs;
    const reporter = new ManifestReporter({ manifestPath });
    reporter.onBegin(fakeConfig({ grep: /matches-nothing/ }));
    reporter.onEnd(undefined as never);

    expect(fs.statSync(manifestPath).mtimeMs).toBe(before);
  });
});
