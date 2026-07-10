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

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { runAutoProjection, _internal } from '../auto-project.js';
import { logger } from '../../../lib/logger.js';

const DORK_HOME = '/tmp/dork-home';
const PROJECT = '/tmp/my-project';

/** A minimal projection plan stub — `applyPlan`/`project` are stubbed, so its shape is opaque to the service. */
const FAKE_PLAN = { actions: [], drops: [] } as never;

describe('runAutoProjection', () => {
  let scaffoldSpy: ReturnType<typeof vi.spyOn>;
  let projectSpy: ReturnType<typeof vi.spyOn>;
  let applyPlanSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: project-scoped + auto-sync on + manifest present.
    mockConfigGet.mockReturnValue({ autoSync: true });
    vi.mocked(existsSync).mockReturnValue(true);

    scaffoldSpy = vi.spyOn(_internal, 'scaffoldManifest').mockReturnValue({
      created: false,
      path: '.agents/harness.manifest.json',
      harnesses: [],
      detected: false,
    });
    projectSpy = vi.spyOn(_internal, 'project').mockReturnValue(FAKE_PLAN);
    applyPlanSpy = vi
      .spyOn(_internal, 'applyPlan')
      .mockReturnValue({ applied: [], conflicts: [], swept: [] });
  });

  describe('global installs (no projectPath)', () => {
    it('is a deliberate no-op and never touches the engine', async () => {
      await runAutoProjection({ packageName: 'pkg', action: 'install' }, { dorkHome: DORK_HOME });

      expect(projectSpy).not.toHaveBeenCalled();
      expect(applyPlanSpy).not.toHaveBeenCalled();
      expect(scaffoldSpy).not.toHaveBeenCalled();
      expect(mockConfigGet).not.toHaveBeenCalled(); // scope is checked before config
      expect(logger.debug).toHaveBeenCalled();
    });

    it('no-ops for a global uninstall too', async () => {
      await runAutoProjection({ packageName: 'pkg', action: 'uninstall' }, { dorkHome: DORK_HOME });
      expect(applyPlanSpy).not.toHaveBeenCalled();
    });
  });

  describe('autoSync disabled', () => {
    it('no-ops when harness.autoSync is false even for a project install', async () => {
      mockConfigGet.mockReturnValue({ autoSync: false });

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(mockConfigGet).toHaveBeenCalledWith('harness');
      expect(projectSpy).not.toHaveBeenCalled();
      expect(applyPlanSpy).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalled();
    });
  });

  describe('project-scoped + autoSync on', () => {
    it('scaffolds the manifest when absent, then projects with the orphan sweep', async () => {
      // Absent on the first check; the scaffold creates it, so the post-scaffold
      // re-check sees it and projection proceeds.
      vi.mocked(existsSync).mockReturnValueOnce(false).mockReturnValue(true);
      scaffoldSpy.mockReturnValue({
        created: true,
        path: '.agents/harness.manifest.json',
        harnesses: ['claude-code', 'codex'],
        detected: true,
      });

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(scaffoldSpy).toHaveBeenCalledWith(PROJECT);
      expect(projectSpy).toHaveBeenCalledWith(PROJECT, { dorkHome: DORK_HOME });
      expect(applyPlanSpy).toHaveBeenCalledWith(PROJECT, FAKE_PLAN, { sweepOrphans: true });
    });

    it('does NOT scaffold when a manifest already exists, but still projects', async () => {
      vi.mocked(existsSync).mockReturnValue(true); // manifest present

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(scaffoldSpy).not.toHaveBeenCalled();
      expect(projectSpy).toHaveBeenCalledWith(PROJECT, { dorkHome: DORK_HOME });
      expect(applyPlanSpy).toHaveBeenCalledWith(PROJECT, FAKE_PLAN, { sweepOrphans: true });
    });

    it('uninstall runs the same project + apply with sweepOrphans so orphans are pruned', async () => {
      applyPlanSpy.mockReturnValue({
        applied: [],
        conflicts: [],
        swept: ['.agents/skills/pkg__helper'],
      });

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'uninstall' },
        { dorkHome: DORK_HOME }
      );

      expect(projectSpy).toHaveBeenCalledWith(PROJECT, { dorkHome: DORK_HOME });
      expect(applyPlanSpy).toHaveBeenCalledWith(PROJECT, FAKE_PLAN, { sweepOrphans: true });
      // The sweep is what prunes the now-orphaned uninstall projection.
      expect(applyPlanSpy.mock.calls[0][2]).toEqual({ sweepOrphans: true });
    });

    it('bails out (no projection) when the manifest still does not exist after scaffold', async () => {
      vi.mocked(existsSync).mockReturnValue(false); // scaffold could not create it
      scaffoldSpy.mockReturnValue({
        created: false,
        path: '.agents/harness.manifest.json',
        harnesses: [],
        detected: false,
      });

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(scaffoldSpy).toHaveBeenCalledWith(PROJECT);
      expect(projectSpy).not.toHaveBeenCalled();
      expect(applyPlanSpy).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalled();
    });

    it('warns when an install contributes NOTHING to the plan (silent zero-projection, DOR-264)', async () => {
      // Plan has actions, but none sourced from the just-installed package —
      // the package is invisible to projection (e.g. the scanner failed to
      // recognize it). This must be loud, not an `applied: 0` info line.
      projectSpy.mockReturnValue({
        actions: [{ kind: 'symlink', source: '.dork/plugins/other-pkg/skills/x' }],
        drops: [],
        warnings: [],
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

    it('does NOT warn when the installed package contributes to the plan', async () => {
      projectSpy.mockReturnValue({
        actions: [{ kind: 'symlink', source: '.dork/plugins/pkg/skills/helper' }],
        drops: [],
        warnings: [],
      } as never);

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does NOT emit the zero-projection warning for an uninstall (its package is GONE from the plan by design)', async () => {
      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'uninstall' },
        { dorkHome: DORK_HOME }
      );

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('warns when applyPlan reports a blocking conflict but still completes', async () => {
      applyPlanSpy.mockReturnValue({
        applied: [],
        conflicts: ['.codex/hooks.json'],
        swept: [],
      });

      await runAutoProjection(
        { projectPath: PROJECT, packageName: 'pkg', action: 'install' },
        { dorkHome: DORK_HOME }
      );

      expect(applyPlanSpy).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('best-effort error handling', () => {
    it('never throws when the engine fails; logs a warning instead', async () => {
      projectSpy.mockImplementation(() => {
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
