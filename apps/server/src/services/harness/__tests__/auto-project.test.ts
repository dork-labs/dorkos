/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockConfigGet = vi.fn();
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (...args: unknown[]) => mockConfigGet(...args),
  },
}));

// The seam is spied on, not mocked — `_internal.projectWithConsent` is the whole
// point of this suite (`runAutoProjection` must reach the engine through it and
// nowhere else), so it stays a real reference that `vi.spyOn` replaces.

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { runAutoProjection, _internal } from '../auto-project.js';
import { logger } from '../../../lib/logger.js';

const DORK_HOME = '/tmp/dork-home';
const PROJECT = '/tmp/my-project';

/** A minimal projection plan stub — the seam is stubbed, so its shape is opaque to the trigger. */
const FAKE_PLAN = { actions: [], drops: [], warnings: [] } as never;

/** What the seam reports when a projection landed cleanly and nothing was withheld. */
const CLEAN_RESULT = {
  plan: FAKE_PLAN,
  withheld: [],
  applied: [],
  conflicts: [],
  swept: [],
  removals: [],
  leftAlone: [],
} as never;

/**
 * What the trigger hands the seam: the dork home, the sweep decision, and the
 * harness DorkOS's own default runtime reads. It passes no `decisions` — the
 * seam reads the store, and which packages are allowed is exercised against the
 * real engine in `hook-projection-gate.test.ts`.
 */
const SEAM_OPTS = { dorkHome: DORK_HOME, sweepOrphans: true, dorkosHarness: 'claude-code' };

/** A scaffold that found a manifest already there — the steady-state answer. */
const MANIFEST_ALREADY_THERE = {
  created: false,
  path: '.agents/harness.manifest.json',
  harnesses: [],
  detected: false,
  addedForDorkos: null,
};

describe('runAutoProjection', () => {
  let scaffoldSpy: ReturnType<typeof vi.spyOn>;
  let seamSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: project-scoped + auto-sync on + manifest present.
    // Per KEY, not one shape for all of them: this trigger reads `harness` for
    // the auto-sync flag and `runtimes` for the agent tool DorkOS itself runs,
    // and a single stub would answer `undefined` for the second while every
    // assertion about it still passed.
    mockConfigGet.mockImplementation((key: unknown) =>
      key === 'runtimes' ? { default: 'claude-code' } : { autoSync: true }
    );
    vi.mocked(existsSync).mockReturnValue(true);

    scaffoldSpy = vi.spyOn(_internal, 'scaffoldManifest').mockReturnValue(MANIFEST_ALREADY_THERE);
    seamSpy = vi.spyOn(_internal, 'projectWithConsent').mockReturnValue(CLEAN_RESULT);
  });

  it('HK-07: reaches the engine ONLY through the consent seam, and tells it to sweep', () => {
    // The trigger's whole engine surface, asserted as a set rather than left to
    // a reader: a second entry here would be a second way to reach `project()`,
    // which is the failure `./project-seam-guard.test.ts`
    // guards at the source level.
    expect(Object.keys(_internal).sort()).toEqual(['projectWithConsent', 'scaffoldManifest']);
  });

  describe('global installs (no projectPath)', () => {
    it('is a deliberate no-op and never touches the engine', async () => {
      await runAutoProjection({ packageName: 'pkg', action: 'install' }, { dorkHome: DORK_HOME });

      expect(seamSpy).not.toHaveBeenCalled();
      expect(scaffoldSpy).not.toHaveBeenCalled();
      expect(mockConfigGet).not.toHaveBeenCalled(); // scope is checked before config
      expect(logger.debug).toHaveBeenCalled();
    });

    it('no-ops for a global uninstall too', async () => {
      await runAutoProjection({ packageName: 'pkg', action: 'uninstall' }, { dorkHome: DORK_HOME });
      expect(seamSpy).not.toHaveBeenCalled();
    });
  });

  describe('autoSync disabled', () => {
    it('no-ops when harness.autoSync is false even for a project install', async () => {
      mockConfigGet.mockImplementation((key: unknown) =>
        key === 'runtimes' ? { default: 'claude-code' } : { autoSync: false }
      );

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(mockConfigGet).toHaveBeenCalledWith('harness');
      expect(seamSpy).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalled();
    });
  });

  describe('project-scoped + autoSync on', () => {
    it('TR-02: scaffolds the manifest when absent, then projects with the orphan sweep', async () => {
      // Absent on the first check; the scaffold creates it, so the post-scaffold
      // re-check sees it and projection proceeds.
      vi.mocked(existsSync).mockReturnValueOnce(false).mockReturnValue(true);
      scaffoldSpy.mockReturnValue({
        created: true,
        path: '.agents/harness.manifest.json',
        harnesses: ['claude-code', 'codex'],
        detected: true,
        addedForDorkos: null,
      });

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(scaffoldSpy).toHaveBeenCalledWith(PROJECT, { dorkosHarness: 'claude-code' });
      expect(seamSpy).toHaveBeenCalledWith(PROJECT, SEAM_OPTS);
    });

    it('TR-02, IN-01: says out loud when it turned on the agent tool DorkOS runs', async () => {
      // The one entry in a scaffolded set a person could not have predicted from
      // their own folder. Silence here is the whole of DOR-1901: their project
      // gains a `.claude/CLAUDE.md` and nothing says why.
      vi.mocked(existsSync).mockReturnValueOnce(false).mockReturnValue(true);
      scaffoldSpy.mockReturnValue({
        created: true,
        path: '.agents/harness.manifest.json',
        harnesses: ['codex', 'opencode', 'claude-code'],
        detected: true,
        addedForDorkos: 'claude-code',
      });

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(logger.info).toHaveBeenCalledWith(
        '[HarnessSync] Claude Code is turned on because DorkOS runs it here; ' +
          '.claude/CLAUDE.md will point at your AGENTS.md.',
        { projectPath: PROJECT }
      );
    });

    it('TR-02: says nothing about DorkOS when the folder already showed that tool', async () => {
      vi.mocked(existsSync).mockReturnValueOnce(false).mockReturnValue(true);
      scaffoldSpy.mockReturnValue({
        created: true,
        path: '.agents/harness.manifest.json',
        harnesses: ['claude-code', 'codex'],
        detected: true,
        addedForDorkos: null,
      });

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      const said = vi.mocked(logger.info).mock.calls.map(([line]) => String(line));
      expect(said.filter((line) => line.includes('because DorkOS runs it here'))).toEqual([]);
    });

    it('TR-02: does NOT scaffold when a manifest already exists, but still projects', async () => {
      vi.mocked(existsSync).mockReturnValue(true); // manifest present

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(scaffoldSpy).not.toHaveBeenCalled();
      expect(seamSpy).toHaveBeenCalledWith(PROJECT, SEAM_OPTS);
    });

    it('TR-02, AP-08: uninstall runs the same projection with sweepOrphans so orphans are pruned', async () => {
      const reason = 'The package this skill came from is no longer installed here.';
      seamSpy.mockReturnValue({
        ...(CLEAN_RESULT as unknown as Record<string, unknown>),
        swept: ['.agents/skills/pkg__helper'],
        removals: [{ path: '.agents/skills/pkg__helper', reason }],
      } as never);

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'uninstall' },
        { dorkHome: DORK_HOME }
      );

      // The sweep is what prunes the now-orphaned uninstall projection, and the
      // seam has no default for it — this trigger has to say so every time.
      expect(seamSpy).toHaveBeenCalledWith(PROJECT, SEAM_OPTS);
      expect(seamSpy.mock.calls[0][1]).toEqual({
        dorkHome: DORK_HOME,
        sweepOrphans: true,
        dorkosHarness: 'claude-code',
      });

      // AP-07, DOR-1906: this pass runs unattended, so the deletion is named
      // with its reason rather than counted. Seeded defect: log `swept.length`
      // and nothing else — the shape this had before — and the operator is left
      // with a number and no way back to which file went, or why.
      expect(logger.info).toHaveBeenCalledWith(
        '[HarnessSync] Removed projections whose source is gone',
        expect.objectContaining({
          projectPath: PROJECT,
          removed: [`.agents/skills/pkg__helper — ${reason}`],
        })
      );
    });

    it('bails out (no projection) when the manifest still does not exist after scaffold', async () => {
      vi.mocked(existsSync).mockReturnValue(false); // scaffold could not create it
      scaffoldSpy.mockReturnValue(MANIFEST_ALREADY_THERE);

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(scaffoldSpy).toHaveBeenCalledWith(PROJECT, { dorkosHarness: 'claude-code' });
      expect(seamSpy).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalled();
    });

    it('VC-08: warns when an install contributes NOTHING to the plan (silent zero-projection, DOR-264)', async () => {
      // Plan has actions, but none sourced from the just-installed package —
      // the package is invisible to projection (e.g. the scanner failed to
      // recognize it). This must be loud, not an `applied: 0` info line.
      seamSpy.mockReturnValue({
        ...(CLEAN_RESULT as unknown as Record<string, unknown>),
        plan: {
          actions: [{ kind: 'symlink', source: '.dork/plugins/other-pkg/skills/x' }],
          drops: [],
          warnings: [],
        },
      } as never);

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'ghost-pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(logger.warn).toHaveBeenCalledWith(
        '[HarnessSync] Install projected no files for package',
        expect.objectContaining({ packageName: 'ghost-pkg', projectPath: PROJECT })
      );
    });

    it('VC-08: does NOT warn when the installed package contributes to the plan', async () => {
      seamSpy.mockReturnValue({
        ...(CLEAN_RESULT as unknown as Record<string, unknown>),
        plan: {
          actions: [{ kind: 'symlink', source: '.dork/plugins/pkg/skills/helper' }],
          drops: [],
          warnings: [],
        },
      } as never);

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('VC-08: does NOT emit the zero-projection warning for an uninstall (its package is GONE from the plan by design)', async () => {
      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'uninstall' },
        { dorkHome: DORK_HOME }
      );

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('warns when the seam reports a blocking conflict but still completes', async () => {
      seamSpy.mockReturnValue({
        ...(CLEAN_RESULT as unknown as Record<string, unknown>),
        conflicts: ['.codex/hooks.json'],
      } as never);

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(seamSpy).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('best-effort error handling', () => {
    it('AP-11: never throws when the engine fails; logs a warning instead', async () => {
      seamSpy.mockImplementation(() => {
        throw new Error('boom');
      });

      await expect(
        runAutoProjection(
          { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
          { dorkHome: DORK_HOME }
        )
      ).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
