/**
 * The consent seam, against the real engine on a real temporary project.
 *
 * `hook-projection-gate.test.ts` drives the same engine through
 * `runAutoProjection`, which is one trigger's worth of scope: it asks, it
 * scaffolds, it always sweeps. This suite is about the seam every OTHER trigger
 * shares — the CLI, and the watcher after it — where nobody is asked, the sweep
 * decision is the caller's, and a stored refusal is the only reason some hooks
 * do not land.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// The seam takes its decisions as data, so nothing here needs a config store —
// which is the property the CLI depends on: `--check` must not open one.
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: () => {
      throw new Error('the seam must not read the config store when decisions are passed in');
    },
    set: () => {
      throw new Error('the seam must never write config');
    },
  },
}));

import { planWithConsent, projectWithConsent, scanHookRequests } from '../project-with-consent.js';
import { hookApprovalEntry, type HookDecisions } from '../hook-consent.js';

/** The command the package wants a coding agent to run for it. */
const PLUGIN_COMMAND = 'node ./hooks/guard.mjs';

/** The same hook as `projectedHooks` reports it, for building a stored decision. */
const PLUGIN_HOOKS = [{ event: 'Stop', command: PLUGIN_COMMAND }];

let repo = '';
let home = '';

/** Nothing decided — the shape a fresh install resolves to. */
const UNDECIDED: HookDecisions = { approved: [], refused: [] };

/**
 * Stage a project syncing to Claude Code and Codex, with one project-scoped
 * plugin already unpacked into `.dork/plugins/acme` that ships both a hook and a
 * skill — so a withheld hook can be told apart from a projection that never ran.
 */
function stagePlugin(): void {
  repo = mkdtempSync(join(tmpdir(), 'seam-repo-'));
  home = mkdtempSync(join(tmpdir(), 'seam-home-'));

  mkdirSync(join(repo, '.agents'), { recursive: true });
  writeFileSync(
    join(repo, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] })
  );

  const plugin = join(repo, '.dork', 'plugins', 'acme');
  mkdirSync(join(plugin, '.dork'), { recursive: true });
  writeFileSync(
    join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'acme',
      version: '1.0.0',
      type: 'plugin',
      description: 'A fixture plugin',
      layers: ['hooks', 'skills'],
    })
  );
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  writeFileSync(
    join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: PLUGIN_COMMAND }] }] })
  );
  mkdirSync(join(plugin, 'skills', 'helper'), { recursive: true });
  writeFileSync(join(plugin, 'skills', 'helper', 'SKILL.md'), '---\nname: helper\n---\n# helper\n');
}

/** Rewrite the staged package's `hooks.json`, as a package update would. */
function rewriteHooks(hooks: unknown): void {
  writeFileSync(
    join(repo, '.dork', 'plugins', 'acme', 'hooks', 'hooks.json'),
    JSON.stringify(hooks)
  );
}

/** Everything the Claude settings merge holds, or `''` when nothing wrote one. */
function settingsText(): string {
  const path = join(repo, '.claude', 'settings.local.json');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Everything the generated Codex hooks file holds, or `''` when it was never generated. */
function codexHooksText(): string {
  const path = join(repo, '.codex', 'hooks.json');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/**
 * Whether a path is still there AS A PATH — a symlink included.
 *
 * `existsSync` follows the link, so a projected link whose source was just
 * deleted reads as absent through it, which is the opposite of the question the
 * sweep test asks.
 */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The stored entry for the staged package as it currently stands on disk. */
function entry(): string {
  return hookApprovalEntry({ projectPath: repo, packageName: 'acme', hooks: PLUGIN_HOOKS });
}

describe('projectWithConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stagePlugin();
  });

  afterEach(() => {
    for (const dir of [repo, home]) if (dir) rmSync(dir, { recursive: true, force: true });
    repo = '';
    home = '';
  });

  it('installs an approved package’s hooks and withholds nothing', () => {
    const result = projectWithConsent(repo, {
      dorkHome: home,
      sweepOrphans: true,
      decisions: { approved: [entry()], refused: [] },
    });

    expect(result.withheld).toEqual([]);
    expect(settingsText()).toContain(PLUGIN_COMMAND);
    expect(codexHooksText()).toContain(PLUGIN_COMMAND);
  });

  it('withholds a refused package’s hooks, says WHY, and still projects its skill', () => {
    const result = projectWithConsent(repo, {
      dorkHome: home,
      sweepOrphans: true,
      decisions: { approved: [], refused: [entry()] },
    });

    expect(result.withheld).toHaveLength(1);
    expect(result.withheld[0]!.reason).toBe('refused');
    expect(result.withheld[0]!.request.packageName).toBe('acme');
    expect(result.withheld[0]!.request.hooks).toEqual(PLUGIN_HOOKS);
    expect(settingsText()).not.toContain(PLUGIN_COMMAND);
    expect(codexHooksText()).not.toContain(PLUGIN_COMMAND);
    // The gate is on the hooks, not on the package.
    expect(existsSync(join(repo, '.claude', 'skills', 'acme__helper'))).toBe(true);
  });

  it('withholds a package nobody has decided about, and reports it as unasked', () => {
    const result = projectWithConsent(repo, {
      dorkHome: home,
      sweepOrphans: true,
      decisions: UNDECIDED,
    });

    expect(result.withheld.map((w) => w.reason)).toEqual(['unasked']);
    expect(settingsText()).not.toContain(PLUGIN_COMMAND);
    expect(codexHooksText()).not.toContain(PLUGIN_COMMAND);
  });

  it('treats a package as undecided again once it changes what it wants to run', () => {
    // The refusal expires on its own: the digest covers the exact commands, so a
    // package that rewrites its hooks matches neither list and is asked about
    // again rather than staying refused for ever.
    const stale = { approved: [], refused: [entry()] };
    rewriteHooks({ Stop: [{ hooks: [{ type: 'command', command: 'node ./hooks/other.mjs' }] }] });

    const result = projectWithConsent(repo, {
      dorkHome: home,
      sweepOrphans: true,
      decisions: stale,
    });

    expect(result.withheld.map((w) => w.reason)).toEqual(['unasked']);
    // And an approval expires the same way, which is the safety half.
    const staleApproval = { approved: [entry()], refused: [] };
    rewriteHooks({ Stop: [{ hooks: [{ type: 'command', command: 'node ./hooks/third.mjs' }] }] });
    expect(
      planWithConsent(repo, { dorkHome: home, decisions: staleApproval }).withheld.map(
        (w) => w.reason
      )
    ).toEqual(['unasked']);
  });

  it('lets the refusal win when one entry is in BOTH lists', () => {
    // The store never produces this state — recording either side clears the
    // other — but the two leaves are `operator-only` precisely so a person can
    // hand-edit `~/.dork/config.json`, and hand-editing is how both lists end up
    // holding one entry. Testing approval first made the approve branch win, so
    // a `curl … | sh` a person had turned down installed itself with no withheld
    // block at all. Refusal is checked first: the safe answer, and the one that
    // matches what the file literally says about that package.
    const both = { approved: [entry()], refused: [entry()] };

    const result = projectWithConsent(repo, {
      dorkHome: home,
      sweepOrphans: true,
      decisions: both,
    });

    expect(result.withheld).toHaveLength(1);
    expect(result.withheld[0]!.reason).toBe('refused');
    expect(settingsText()).not.toContain(PLUGIN_COMMAND);
    expect(codexHooksText()).not.toContain(PLUGIN_COMMAND);
  });

  it('reports a package once even when a list holds the same entry twice', () => {
    // A hand-edited file can also repeat an entry. One package, one decision,
    // one line in the report.
    const result = planWithConsent(repo, {
      dorkHome: home,
      decisions: { approved: [], refused: [entry(), entry()] },
    });
    expect(result.withheld).toHaveLength(1);
    expect(result.withheld[0]!.reason).toBe('refused');
  });

  it('sweeps nothing when the caller says not to, even though the plan changed', () => {
    // The watcher's case (DOR-1850): a re-projection mid-edit must not delete a
    // projection whose source is momentarily absent. Project everything first,
    // then remove the source and re-project with the sweep off.
    projectWithConsent(repo, {
      dorkHome: home,
      sweepOrphans: true,
      decisions: { approved: [entry()], refused: [] },
    });
    const projected = join(repo, '.claude', 'skills', 'acme__helper');
    expect(pathExists(projected)).toBe(true);

    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const kept = projectWithConsent(repo, {
      dorkHome: home,
      sweepOrphans: false,
      decisions: UNDECIDED,
    });
    expect(kept.swept).toEqual([]);
    expect(pathExists(projected)).toBe(true);

    // With the sweep on, the same state is pruned — so the assertion above is
    // about the flag and not about a sweep that could never have fired.
    const swept = projectWithConsent(repo, {
      dorkHome: home,
      sweepOrphans: true,
      decisions: UNDECIDED,
    });
    expect(swept.swept.length).toBeGreaterThan(0);
    expect(pathExists(projected)).toBe(false);
  });

  it('refuses to sweep a plan narrowed to one harness', () => {
    // A filtered plan omits every other harness's live projections, and the
    // sweep would read them as orphans and delete them. The caller is not
    // trusted to remember.
    expect(() =>
      projectWithConsent(repo, {
        dorkHome: home,
        sweepOrphans: true,
        harness: 'codex',
        decisions: UNDECIDED,
      })
    ).toThrow(/narrowed to one harness/);
  });

  it('keeps a harness-agnostic drop under every harness filter', () => {
    // A non-portable plugin layer has no home in ANY harness, so hiding it
    // behind `--harness cursor` reports nothing where there is something to
    // report (contract VC-02).
    writeFileSync(
      join(repo, '.dork', 'plugins', 'acme', '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'acme',
        version: '1.0.0',
        type: 'plugin',
        description: 'A fixture plugin',
        layers: ['hooks', 'skills', 'extensions'],
      })
    );

    const { plan } = planWithConsent(repo, {
      dorkHome: home,
      harness: 'cursor',
      decisions: UNDECIDED,
    });
    const layerDrop = plan.drops.find((d) => d.name === 'acme:extensions');
    expect(layerDrop).toBeDefined();
    expect(layerDrop!.harnessAgnostic).toBe(true);
    // Everything genuinely about another harness is still filtered out.
    expect(plan.drops.every((d) => d.harnessAgnostic === true || d.harness === 'cursor')).toBe(
      true
    );
  });

  it('lists one request per hook-declaring package, and none for a package with no hooks', () => {
    expect(scanHookRequests(repo, home).map((r) => r.packageName)).toEqual(['acme']);
    rmSync(join(repo, '.dork', 'plugins', 'acme', 'hooks'), { recursive: true, force: true });
    expect(scanHookRequests(repo, home)).toEqual([]);
  });
});
