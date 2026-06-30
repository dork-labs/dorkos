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
      vi.mocked(existsSync).mockReturnValue(false); // no manifest yet
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
