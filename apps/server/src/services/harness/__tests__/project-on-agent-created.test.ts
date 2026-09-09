/**
 * @vitest-environment node
 *
 * The agent-created trigger (contract TR-11 / J-03, DOR-1901).
 *
 * Pointing a DorkOS agent at a project used to start nothing: `runAutoProjection`
 * fires on a marketplace change, the boot pass covers agent homes, and the
 * watcher refuses a project that has never synced. So a repository somebody
 * pointed an agent at got no manifest, no `.claude/CLAUDE.md`, and a managed
 * session that had never read the person's own `AGENTS.md`.
 *
 * What this suite holds is the SHAPE of that trigger, which is where a
 * projection trigger goes wrong: it must reach the engine through the consent
 * seam and nowhere else, take the project lock, never sweep, never ask, and
 * refuse the two directories that are not its business.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockConfigGet = vi.fn();
vi.mock('../../core/config-manager.js', () => ({
  configManager: { get: (...args: unknown[]) => mockConfigGet(...args) },
}));

// `realpathSync` is the agent-home check's, not this module's: `isAgentHome`
// canonicalizes both sides so a home reached through a symlink still matches.
// Identity here, because the paths in this file are already canonical.
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  realpathSync: (p: string) => p,
}));

import { runAgentCreatedProjection, _internal } from '../project-on-agent-created.js';
import { projectLockQueueDepth } from '../project-with-consent.js';
import { logger } from '../../../lib/logger.js';

const DORK_HOME = '/tmp/dork-home';
const REPO = '/tmp/someones-repo';
const AGENT = { name: 'tangerines', path: REPO };

/** A minimal plan stub — the seam is stubbed, so its shape is opaque to the trigger. */
const FAKE_PLAN = { actions: [], drops: [], warnings: [], notEnabled: [] } as never;

/** What the seam reports when a projection landed cleanly and nothing was withheld. */
const CLEAN_RESULT = {
  plan: FAKE_PLAN,
  withheld: [],
  applied: [],
  conflicts: [],
  swept: [],
  leftAlone: [],
} as never;

/** A scaffold that found a manifest already there. */
const MANIFEST_ALREADY_THERE = {
  created: false,
  path: '.agents/harness.manifest.json',
  harnesses: [],
  detected: false,
  addedForDorkos: null,
};

describe('runAgentCreatedProjection', () => {
  let scaffoldSpy: ReturnType<typeof vi.spyOn>;
  let seamSpy: ReturnType<typeof vi.spyOn>;
  let boundarySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Per KEY: the trigger reads `harness` for the auto-sync flag and `runtimes`
    // for the agent tool DorkOS itself runs.
    mockConfigGet.mockImplementation((key: unknown) =>
      key === 'runtimes' ? { default: 'claude-code' } : { autoSync: true }
    );
    vi.mocked(existsSync).mockReturnValue(true); // manifest present by default
    scaffoldSpy = vi.spyOn(_internal, 'scaffoldManifest').mockReturnValue(MANIFEST_ALREADY_THERE);
    seamSpy = vi.spyOn(_internal, 'projectWithConsent').mockReturnValue(CLEAN_RESULT);
    boundarySpy = vi.spyOn(_internal, 'withinBoundary').mockResolvedValue(true);
  });

  it('J-03, TR-11: projects the repo an agent was pointed at, through the consent seam', async () => {
    await runAgentCreatedProjection(AGENT, { dorkHome: DORK_HOME });

    // The trigger's WHOLE engine surface, asserted as a set: a second entry here
    // would be a second way to reach `project()`, which `project-seam-guard`
    // forbids at the source level.
    expect(Object.keys(_internal).sort()).toEqual([
      'projectWithConsent',
      'scaffoldManifest',
      'withinBoundary',
    ]);
    expect(seamSpy).toHaveBeenCalledWith(REPO, {
      dorkHome: DORK_HOME,
      // A trigger never sweeps (contract D5): this runs off somebody's action on
      // a tree they may be mid-edit in.
      sweepOrphans: false,
      dorkosHarness: 'claude-code',
    });
  });

  it('TR-11: takes the project lock for the whole of it', async () => {
    // Measured from inside the seam call: if the lock were not held there, two
    // agents created against one repository could interleave their projections.
    let depthInside = 0;
    seamSpy.mockImplementation(() => {
      depthInside = projectLockQueueDepth(REPO);
      return CLEAN_RESULT as never;
    });

    await runAgentCreatedProjection(AGENT, { dorkHome: DORK_HOME });

    expect(depthInside).toBe(1);
    // And released: nothing is queued once the turn is over.
    expect(projectLockQueueDepth(REPO)).toBe(0);
  });

  it('J-03, IN-01: scaffolds a manifest for a project that has none, and says what it added', async () => {
    vi.mocked(existsSync).mockReturnValueOnce(false).mockReturnValue(true);
    scaffoldSpy.mockReturnValue({
      created: true,
      path: '.agents/harness.manifest.json',
      harnesses: ['codex', 'opencode', 'claude-code'],
      detected: true,
      addedForDorkos: 'claude-code',
    });

    await runAgentCreatedProjection(AGENT, { dorkHome: DORK_HOME });

    // Scaffolding here is deliberate and is one of only two paths allowed to do
    // it unprompted: the person just asked DorkOS to work in this folder.
    expect(scaffoldSpy).toHaveBeenCalledWith(REPO, { dorkosHarness: 'claude-code' });
    expect(logger.info).toHaveBeenCalledWith(
      '[HarnessSync] Claude Code is turned on because DorkOS runs it here; ' +
        '.claude/CLAUDE.md will point at your AGENTS.md.',
      { path: REPO }
    );
    expect(seamSpy).toHaveBeenCalledTimes(1);
  });

  it('TR-03, TR-11: leaves a workspace the create pipeline built to its own pass', async () => {
    // The race this trigger must lose on purpose. `createAgentWorkspace`
    // notifies the seam BEFORE it runs `projectAgentWorkspace`, and by then it
    // has already scaffolded `AGENTS.md`, `.claude/CLAUDE.md`, `GEMINI.md` and
    // the Copilot pointer into the workspace — so detection here reads DorkOS's
    // own scaffolds as four harnesses somebody uses, and both scaffolds are
    // write-if-absent, so this one would win. Measured on a real server against
    // a directory override: `claude-code, codex, gemini, copilot, opencode`,
    // where the create pipeline means Claude Code alone with package hooks
    // denied (HK-08) — and a codex-enabled manifest is what turns an unattended
    // pass into a writer of shell commands.
    await runAgentCreatedProjection(
      { ...AGENT, workspaceProjectedByPipeline: true },
      { dorkHome: DORK_HOME }
    );

    expect(seamSpy).not.toHaveBeenCalled();
    expect(scaffoldSpy).not.toHaveBeenCalled();
    // Decided before anything else is asked, so a no-op never queues behind
    // somebody else's projection.
    expect(boundarySpy).not.toHaveBeenCalled();
    expect(mockConfigGet).not.toHaveBeenCalled();
  });

  it('J-03, TR-11: still projects for a path a person named, which is not the pipeline', async () => {
    // `POST /api/agents` mints a manifest at a directory somebody chose and
    // scaffolds nothing else. It declares `origin: 'created'` like the pipeline
    // does, and skipping on THAT string would skip the exact journey this
    // trigger exists for — a person pointing an agent at a repo they work in.
    await runAgentCreatedProjection(
      { ...AGENT, workspaceProjectedByPipeline: false },
      { dorkHome: DORK_HOME }
    );

    expect(seamSpy).toHaveBeenCalledWith(REPO, {
      dorkHome: DORK_HOME,
      sweepOrphans: false,
      dorkosHarness: 'claude-code',
    });
  });

  it('TR-11: leaves an agent home to its own pass', async () => {
    // `<dorkHome>/agents/*` is projected by `agent-creator` at creation and by
    // the boot backfill after, with a Claude-Code-only manifest on purpose.
    // Doing it again here would write a different harness set into that folder.
    await runAgentCreatedProjection(
      { name: 'dorkbot', path: `${DORK_HOME}/agents/dorkbot` },
      { dorkHome: DORK_HOME }
    );

    expect(seamSpy).not.toHaveBeenCalled();
    expect(scaffoldSpy).not.toHaveBeenCalled();
    // Decided before anything else is even asked, so a no-op never queues behind
    // somebody else's projection.
    expect(boundarySpy).not.toHaveBeenCalled();
    expect(mockConfigGet).not.toHaveBeenCalled();
  });

  it('TR-11: writes nothing outside the directory boundary', async () => {
    // The seam has four callers and one of them is a mesh discovery scan that
    // never went near a route, so the path is judged here too.
    boundarySpy.mockResolvedValue(false);

    await runAgentCreatedProjection(AGENT, { dorkHome: DORK_HOME });

    expect(seamSpy).not.toHaveBeenCalled();
    expect(scaffoldSpy).not.toHaveBeenCalled();
  });

  it('TR-11: does nothing when the person has turned auto-sync off', async () => {
    mockConfigGet.mockImplementation((key: unknown) =>
      key === 'runtimes' ? { default: 'claude-code' } : { autoSync: false }
    );

    await runAgentCreatedProjection(AGENT, { dorkHome: DORK_HOME });

    expect(seamSpy).not.toHaveBeenCalled();
    expect(scaffoldSpy).not.toHaveBeenCalled();
  });

  it('TR-11: counts withheld hooks rather than asking about them', async () => {
    // An approval card raised by "I made an agent" is a card at the wrong
    // moment. The install path is where the card belongs.
    seamSpy.mockReturnValue({
      ...(CLEAN_RESULT as unknown as Record<string, unknown>),
      withheld: [
        { reason: 'unasked', request: { packageName: 'acme', projectPath: REPO, hooks: [] } },
      ],
    } as never);

    await runAgentCreatedProjection(AGENT, { dorkHome: DORK_HOME });

    expect(logger.info).toHaveBeenCalledWith(
      '[HarnessSync] Projected the project a new agent was pointed at',
      expect.objectContaining({ hooksWithheld: 1, swept: 0 })
    );
  });

  it('TR-11: swallows a projection failure so a created agent is never lost to it', async () => {
    seamSpy.mockImplementation(() => {
      throw new Error('disk is full');
    });

    await expect(
      runAgentCreatedProjection(AGENT, { dorkHome: DORK_HOME })
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Projecting a new agent’s project failed'),
      expect.objectContaining({ error: 'disk is full', path: REPO })
    );
    // The lock is released by a failing turn exactly as by a succeeding one.
    expect(projectLockQueueDepth(REPO)).toBe(0);
  });

  it('TR-11: bails out when the manifest still does not exist after the scaffold', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    await runAgentCreatedProjection(AGENT, { dorkHome: DORK_HOME });

    expect(scaffoldSpy).toHaveBeenCalledWith(REPO, { dorkosHarness: 'claude-code' });
    expect(seamSpy).not.toHaveBeenCalled();
  });
});
