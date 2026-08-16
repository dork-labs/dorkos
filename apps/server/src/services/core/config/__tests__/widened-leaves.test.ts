/**
 * Values written by a build that widened a setting this one already has
 * (DOR-1227).
 *
 * The defect these cover is the second half of config version skew. DOR-1221
 * stopped an unrecognized KEY from condemning `~/.dork/config.json`; a
 * recognized key holding a VALUE a newer build allows still did. Seed
 * `ui.theme: 'midnight'` against a build with three themes and the whole file
 * was backed up and replaced with defaults — `mesh.scanRoots`, `approvals`,
 * `runtimes`, every preference, over one word.
 *
 * Every test that matters here drives a REAL `ConfigManager` over a real file in
 * a temp directory, because the seam that broke is `conf`'s Ajv validation. A
 * mock store never reaches it, and `UserConfigSchema.parse` cannot stand in for
 * it: Zod strips and defaults where Ajv rejects.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { UserConfigSchema, USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { logger } from '../../../../lib/logger.js';
import { ConfigManager, WIDENED_LEAF_POLICY } from '../../config-manager.js';
import {
  preserveWidenedLeaves,
  relaxWidenedLeaves,
  repairWidenedLeaves,
} from '../widened-leaves.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logError: vi.fn(() => ({})),
}));

/** Every `logger.warn` line since the current test began. */
const warnings: string[] = [];

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.warn).mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
  warnings.length = 0;
});

/** How many times `needle` appears in `haystack`. */
function occurrencesOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The retry staircase with the waiting taken out; see `config-load-failure.test.ts`. */
const FAST_RETRIES = { retryDelaysMs: [0, 0, 0] } as const;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp data directory holding the given config file.
 *
 * @param stored - The exact object to write as `config.json`.
 */
function seed(stored: Record<string, unknown>): { dir: string; configPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-widened-'));
  dirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(stored, null, 2));
  return { dir, configPath };
}

/** The config file as it stands on disk right now. */
function onDisk(configPath: string): Record<string, Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
    string,
    Record<string, unknown>
  >;
}

/** Every backup of the config file, whatever it is named. */
function backupsIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.bak'));
}

describe('a leaf holding a value a newer build widened', () => {
  it('boots on the default and condemns nothing — a new enum member', () => {
    // The reported shape. A build that adds a theme writes it; the build that
    // does not have it must still be able to read everything else.
    const { dir, configPath } = seed({
      version: 1,
      ui: { theme: 'midnight' },
      auth: { enabled: true },
      mesh: { scanRoots: ['/projects'] },
    });

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toEqual([]);
    expect(manager.get('ui').theme).toBe('system');
    // Nothing else was touched, which is the entire point of not condemning.
    expect(manager.get('auth').enabled).toBe(true);
    expect(manager.get('mesh').scanRoots).toEqual(['/projects']);
    // And the build that owns the value still has it.
    expect(onDisk(configPath).ui?.theme).toBe('midnight');
  });

  it('boots on the default — a bound a newer build raised', () => {
    // `server.port` has a floor of 1024 and `logging.maxLogFiles` a ceiling of
    // 30. A build that lets someone bind port 80, or keep 90 days of logs,
    // writes a number this one refuses.
    const { dir, configPath } = seed({
      version: 1,
      server: { port: 80 },
      logging: { maxLogFiles: 90 },
    });

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toEqual([]);
    expect(manager.get('server').port).toBe(4242);
    expect(manager.get('logging').maxLogFiles).toBe(14);
    const stored = onDisk(configPath);
    expect(stored.server?.port).toBe(80);
    expect(stored.logging?.maxLogFiles).toBe(90);
  });

  it('boots on the default — a leaf a newer build retyped', () => {
    // `server.port` becoming `'auto'`, and a nullable string becoming a number.
    // Both are recognized keys, so before this they condemned the file.
    const { dir, configPath } = seed({
      version: 1,
      server: { port: 'auto', cwd: 42 },
    });

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toEqual([]);
    expect(manager.get('server').port).toBe(4242);
    expect(manager.get('server').cwd).toBeNull();
    expect(onDisk(configPath).server?.port).toBe('auto');
    expect(onDisk(configPath).server?.cwd).toBe(42);
  });

  it('reaches a leaf nested two levels down', () => {
    // The tolerance follows `properties` all the way in, so a per-runtime
    // setting is covered exactly as a top-level one is.
    const { dir } = seed({
      version: 1,
      runtimes: { default: 'claude-code', codex: { defaultEffort: 'ludicrous' } },
    });

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toEqual([]);
    expect(manager.get('runtimes').codex.defaultEffort).toBeNull();
  });

  it('survives the boot that rewrites the file, and the next one', () => {
    // Booting is not enough on its own: `conf` writes the store back during an
    // ordinary boot, so a value tolerated on the way in could still be dropped
    // on the way out — and then the second boot has nothing left to tolerate.
    const { dir, configPath } = seed({ version: 1, ui: { theme: 'midnight' } });

    new ConfigManager(dir, FAST_RETRIES);
    new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toEqual([]);
    expect(onDisk(configPath).ui?.theme).toBe('midnight');
  });

  it('reports the value it is running on, not the one it cannot read', () => {
    // `getDot` is how the CLI decides the real port, the log level and whether
    // to open a tunnel. Handing back a value this build cannot interpret would
    // put the CLI and the server on different settings from one file.
    const { dir } = seed({ version: 1, server: { port: 80 }, ui: { theme: 'midnight' } });

    const manager = new ConfigManager(dir, FAST_RETRIES);

    // Asserted first: without it, every expectation below is also satisfied by
    // the old behaviour of wiping the file and starting from defaults.
    expect(backupsIn(dir)).toEqual([]);
    expect(manager.getDot('server.port')).toBe(4242);
    expect(manager.getDot('ui.theme')).toBe('system');
    expect(manager.getAll().ui.theme).toBe('system');
    // Repairing at the read boundary must not cost `dot-prop`'s escaping: a
    // record key with a literal dot in it is still reachable, because `conf`
    // still does the lookup and the repair is applied to what came back.
    manager.setDot('workbench.defaultViewers', { '/notes/a.tex': 'markdown' });
    expect(manager.getDot('workbench.defaultViewers./notes/a\\.tex')).toBe('markdown');
    // And `dorkos config validate` does not tell the person their settings are
    // broken over a value that costs them nothing — it names them instead.
    expect(manager.validate()).toEqual({
      valid: true,
      warnings: ['server.port: 80 (using 4242)', 'ui.theme: "midnight" (using "system")'],
    });
  });
});

describe('saying which settings it could not read', () => {
  it('names them once at boot, and says nothing about a clean file', () => {
    // Tolerated is not silent. `auth.enabled` decides whether the login gate is
    // on; before this feature a file it could not read was condemned LOUDLY,
    // with a backup and a line the operator saw. Falling back quietly would turn
    // that into a gate off with nothing anywhere to say so.
    const { dir } = seed({ version: 1, ui: { theme: 'midnight' }, auth: { enabled: 'sso' } });

    new ConfigManager(dir, FAST_RETRIES);

    const lines = warnings.filter((line) => line.includes('cannot read'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2 settings hold values');
    expect(occurrencesOf(lines[0]!, 'ui.theme')).toBe(1);
    expect(occurrencesOf(lines[0]!, 'auth.enabled')).toBe(1);
    // What it fell back to, because "we ignored auth.enabled" and "the login
    // gate is off" are the same news and only one of them is actionable.
    expect(lines[0]).toContain('"midnight" (using "system")');
    expect(lines[0]).toContain('(using false)');

    warnings.length = 0;
    new ConfigManager(seed({ version: 1, ui: { theme: 'dark' } }).dir, FAST_RETRIES);
    expect(warnings.filter((line) => line.includes('cannot read'))).toEqual([]);
  });

  it('says it once per boot, not once per read', () => {
    // `get` runs the same repair on every call, so a warning per read would bury
    // the one that matters under thousands of copies of itself.
    const { dir } = seed({ version: 1, ui: { theme: 'midnight' } });

    const manager = new ConfigManager(dir, FAST_RETRIES);
    for (let i = 0; i < 5; i++) manager.get('ui');
    manager.getAll();

    expect(warnings.filter((line) => line.includes('cannot read'))).toHaveLength(1);
  });

  it('never prints a credential, only the path that holds one', () => {
    // The four SENSITIVE_CONFIG_KEYS are nullable strings with defaults, so they
    // are all relaxed — a newer build changing how a token is encoded would
    // otherwise put that token in a log file the moment an older build read it.
    const { dir } = seed({ version: 1, mcp: { apiKey: { v2: 'sk-live-do-not-log' } } });

    const manager = new ConfigManager(dir, FAST_RETRIES);

    const printed = [...warnings, ...(manager.validate().warnings ?? [])].join('\n');
    expect(printed).toContain('mcp.apiKey');
    expect(printed).toContain('<hidden>');
    expect(printed).not.toContain('sk-live-do-not-log');
  });

  it('reports them from validate as warnings, and still says the config is valid', () => {
    // `dorkos config validate` keeps its point for the hand-edit case without
    // telling somebody their settings are broken — which is what sends people to
    // delete the file this exists to keep.
    const { dir } = seed({ version: 1, approvals: { trustWindowMinutes: '5m' } });

    const result = new ConfigManager(dir, FAST_RETRIES).validate();

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(['approvals.trustWindowMinutes: "5m" (using 480)']);
  });

  it('reports nothing from validate when every value is readable', () => {
    const { dir } = seed({ version: 1, ui: { theme: 'dark' } });
    expect(new ConfigManager(dir, FAST_RETRIES).validate()).toEqual({ valid: true });
  });
});

describe('writing from the build that cannot read the value', () => {
  it('keeps the stored value when the write does not name that leaf', () => {
    // The quiet version of the same data loss. This build read `theme` as
    // `system`, so the section it saves says `system`, and the person's real
    // choice would leave the file one preference at a time.
    const { dir, configPath } = seed({
      version: 1,
      ui: { theme: 'midnight' },
      server: { port: 80 },
    });

    const manager = new ConfigManager(dir, FAST_RETRIES);
    // Exactly what `applyConfigPatch` writes: the whole section, Zod-validated.
    const validated = UserConfigSchema.parse(manager.getAll());
    manager.set('ui', { ...validated.ui, dismissedUpgradeVersions: ['0.59.0'] });
    manager.setDot('server.open', false);

    const stored = onDisk(configPath);
    expect(stored.ui?.theme).toBe('midnight');
    expect(stored.server?.port).toBe(80);
    // And the writes themselves still landed.
    expect(stored.ui?.dismissedUpgradeVersions).toEqual(['0.59.0']);
    expect(stored.server?.open).toBe(false);
  });

  it('keeps a widened leaf when a sibling of it is written by dot-path', () => {
    // The nested case, which the section-level test above cannot reach: the
    // write names `runtimes.codex.enabled`, and `defaultEffort` beside it — two
    // levels down, in the same object — has to come through untouched.
    const { dir, configPath } = seed({
      version: 1,
      runtimes: { default: 'claude-code', codex: { enabled: true, defaultEffort: 'ludicrous' } },
    });

    const manager = new ConfigManager(dir, FAST_RETRIES);
    manager.setDot('runtimes.codex', { ...manager.get('runtimes').codex, enabled: false });

    const codex = onDisk(configPath).runtimes?.codex as Record<string, unknown>;
    expect(backupsIn(dir)).toEqual([]);
    expect(codex.defaultEffort).toBe('ludicrous');
    expect(codex.enabled).toBe(false);
  });

  it('lets a person on this build overwrite it', () => {
    // Preservation must not become a value nobody can change. A write carrying
    // anything other than what this build handed out is somebody choosing.
    const { dir, configPath } = seed({ version: 1, ui: { theme: 'midnight' } });

    const manager = new ConfigManager(dir, FAST_RETRIES);
    const validated = UserConfigSchema.parse(manager.getAll());
    manager.set('ui', { ...validated.ui, theme: 'dark' });

    expect(backupsIn(dir)).toEqual([]);
    expect(onDisk(configPath).ui?.theme).toBe('dark');
    expect(new ConfigManager(dir, FAST_RETRIES).get('ui').theme).toBe('dark');
  });

  it('lets a dot-path write overwrite it too', () => {
    const { dir, configPath } = seed({ version: 1, server: { port: 80 } });

    const manager = new ConfigManager(dir, FAST_RETRIES);
    manager.setDot('server.port', 5000);

    expect(backupsIn(dir)).toEqual([]);
    expect(onDisk(configPath).server?.port).toBe(5000);
  });

  it('still puts a named section back to its defaults on reset', () => {
    // `reset` is an instruction, not an accident — the same carve-out
    // `preserveUnknownKeys` makes, for the same reason.
    const { dir, configPath } = seed({ version: 1, ui: { theme: 'midnight' } });

    const manager = new ConfigManager(dir, FAST_RETRIES);
    manager.reset('ui');

    expect(backupsIn(dir)).toEqual([]);
    expect(onDisk(configPath).ui?.theme).toBe('system');
  });
});

describe('what is still damage', () => {
  it('condemns a section whose shape is wrong', () => {
    // The control. `mesh.scanRoots` is a list, so a string there is not a value
    // another build widened — it is a shape the schema does not describe, and
    // recovery is still the right answer.
    const { dir } = seed({
      version: 1,
      mesh: { scanRoots: 'not-a-list' },
      auth: { enabled: true },
    });

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toHaveLength(1);
    expect(manager.get('mesh').scanRoots).toEqual([]);
    // DOR-584 still holds on that path: a wipe may lose preferences, never a
    // protection.
    expect(manager.get('auth').enabled).toBe(true);
  });

  it('condemns an object where a nested object is expected', () => {
    const { dir } = seed({ version: 1, ui: { statusBar: ['pins'] } });

    new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toHaveLength(1);
  });

  it('condemns a file that will not parse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-widened-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), '{ truncated');

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(manager.get('server').port).toBe(4242);
  });

  it('condemns a new member INSIDE a list — the named residual', () => {
    // Pinned rather than left for somebody to discover. Tolerance stops where
    // preservation stops: an element of `ui.statusBar.pins` has a position, not
    // a name, so no honest rule carries it back across a write, and a value that
    // cannot be carried must not be tolerated either.
    const { dir } = seed({ version: 1, ui: { statusBar: { pins: ['cwd', 'weather'] } } });

    new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toHaveLength(1);
  });

  it('condemns a new member inside a RECORD — the same residual', () => {
    const { dir } = seed({ version: 1, workbench: { defaultViewers: { '/a.tex': 'latex' } } });

    new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toHaveLength(1);
  });

  it('condemns a config claiming a different format version', () => {
    // `version` has no schema default, so there is nothing to fall back to — and
    // a build that changes the config format outright is not merely widening a
    // setting.
    const { dir } = seed({ version: 2, ui: { theme: 'dark' } });

    new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toHaveLength(1);
  });
});

describe('the leaves the schema hands to Zod', () => {
  it('covers the settings a build is most likely to widen', () => {
    // A drift guard with teeth: if the relaxation ever stops reaching nested
    // sections, or stops reaching enums, these go missing and the wipe comes
    // back only on machines running two builds.
    expect(WIDENED_LEAF_POLICY.paths.has('ui.theme')).toBe(true);
    expect(WIDENED_LEAF_POLICY.paths.has('server.port')).toBe(true);
    expect(WIDENED_LEAF_POLICY.paths.has('logging.level')).toBe(true);
    expect(WIDENED_LEAF_POLICY.paths.has('runtimes.codex.defaultEffort')).toBe(true);
    expect(WIDENED_LEAF_POLICY.paths.has('workspace.defaultProvider')).toBe(true);
  });

  it('reaches no container, list or record', () => {
    // The other side of the same guard. A relaxed container would mean Ajv stops
    // checking a shape and nothing in DorkOS starts, which is how tolerance
    // becomes "validate nothing".
    expect(WIDENED_LEAF_POLICY.paths.has('ui')).toBe(false);
    expect(WIDENED_LEAF_POLICY.paths.has('ui.sidebar')).toBe(false);
    expect(WIDENED_LEAF_POLICY.paths.has('mesh.scanRoots')).toBe(false);
    expect(WIDENED_LEAF_POLICY.paths.has('ui.statusBar.pins')).toBe(false);
    expect(WIDENED_LEAF_POLICY.paths.has('workbench.defaultViewers')).toBe(false);
    expect(WIDENED_LEAF_POLICY.paths.has('version')).toBe(false);
    for (const leaf of WIDENED_LEAF_POLICY.paths) expect(leaf).not.toMatch(/\.\d/);
  });

  it('falls back to the value a fresh install has, on every one of them', () => {
    // Config defaults are declared TWICE in this codebase — per field, and as
    // the object literal each section's `.default()` carries. The repair uses
    // the per-field one; a fresh install uses whichever the section literal
    // names. This asserts they agree at every leaf the repair can reach, so a
    // future disagreement is a red test rather than a build quietly running on a
    // value no fresh install would have. It also proves every relaxed leaf is
    // reachable and repairable at all, which is the invariant that keeps the Ajv
    // side and the Zod side describing the same set.
    const fresh = USER_CONFIG_DEFAULTS as unknown as Record<string, unknown>;
    expect(WIDENED_LEAF_POLICY.paths.size).toBeGreaterThan(50);
    for (const leaf of WIDENED_LEAF_POLICY.paths) {
      const [section, ...rest] = leaf.split('.');
      const { value, skewed } = repairWidenedLeaves(
        section!,
        // An object, because every relaxed leaf is a SCALAR — no widening of a
        // scalar can ever accept one, so this fails all of them at once.
        withPathSet(fresh[section!], rest, { shapeNoLeafAccepts: true }),
        WIDENED_LEAF_POLICY
      );
      expect(
        skewed.map((entry) => entry.path),
        leaf
      ).toEqual([leaf]);
      expect(readPath(value, rest), leaf).toStrictEqual(readPath(fresh[section!], rest));
    }
  });
});

/** Read a dot-path out of a nested plain object. */
function readPath(root: unknown, segments: readonly string[]): unknown {
  let node = root;
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** A copy of `root` with `value` written at a dot-path. */
function withPathSet(root: unknown, segments: readonly string[], value: unknown): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  if (typeof root !== 'object' || root === null) return root;
  return {
    ...(root as Record<string, unknown>),
    [head]: withPathSet(readPath(root, [head]), rest, value),
  };
}

/**
 * A JSON-Schema fragment shaped like the real one, over real config paths — the
 * paths have to be real because relaxing a leaf now depends on Zod being able to
 * reach it.
 */
function fragment(): Record<string, Record<string, unknown>> {
  return {
    version: { type: 'number', const: 1 },
    server: {
      type: 'object',
      properties: {
        port: { type: 'integer', minimum: 1024, default: 4242, description: 'Port' },
        cwd: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
        notAFieldAnyBuildHas: { type: 'string', default: 'x' },
      },
    },
    ui: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['light', 'dark'], default: 'system' },
        dismissedUpgradeVersions: { type: 'array', items: { type: 'string' }, default: [] },
        statusBar: {
          type: 'object',
          properties: {
            pins: { type: 'array', items: { type: 'string', enum: ['cwd'] }, default: [] },
          },
        },
      },
    },
    workbench: {
      type: 'object',
      properties: {
        defaultViewers: { type: 'object', additionalProperties: { type: 'string' }, default: {} },
      },
    },
  };
}

describe('relaxWidenedLeaves', () => {
  it('opens exactly the named scalar leaves, and nothing else', () => {
    const schema = fragment();

    const policy = relaxWidenedLeaves(schema);

    expect([...policy.paths].sort()).toEqual(['server.cwd', 'server.port', 'ui.theme']);
    expect([...policy.bySection.keys()].sort()).toEqual(['server', 'ui']);
  });

  it('leaves a leaf Zod cannot reach for Ajv to guard', () => {
    // The consistency gate. DorkOS can only check a leaf it can find in the Zod
    // schema, so a leaf it cannot find must stay Ajv's problem — otherwise the
    // relaxation would open a position nothing guards at all.
    const schema = fragment();

    const policy = relaxWidenedLeaves(schema);

    expect(policy.paths.has('server.notAFieldAnyBuildHas')).toBe(false);
    expect(schema.server?.properties).toMatchObject({
      notAFieldAnyBuildHas: { type: 'string', default: 'x' },
    });
  });

  it('leaves a leaf with no default alone, and every container', () => {
    const schema = fragment();

    const policy = relaxWidenedLeaves(schema);

    // No default, nothing to fall back to.
    expect(policy.paths.has('version')).toBe(false);
    expect(schema.version).toEqual({ type: 'number', const: 1 });
    // Lists and records keep every constraint, inside and out.
    expect(policy.paths.has('ui.dismissedUpgradeVersions')).toBe(false);
    expect(policy.paths.has('ui.statusBar.pins')).toBe(false);
    expect(policy.paths.has('workbench.defaultViewers')).toBe(false);
    expect(schema.ui?.properties).toMatchObject({
      statusBar: { properties: { pins: { items: { type: 'string', enum: ['cwd'] } } } },
    });
    expect(schema.workbench?.properties).toMatchObject({
      defaultViewers: { additionalProperties: { type: 'string' } },
    });
  });

  it('keeps the default on a relaxed leaf and drops everything that can reject', () => {
    // conf builds Ajv with `useDefaults`, so dropping the default with the
    // constraints would turn "tolerate a widened value" into "forget every unset
    // preference".
    const schema = fragment();

    relaxWidenedLeaves(schema);

    expect(schema.server?.properties).toMatchObject({
      port: { default: 4242, description: 'Port' },
      cwd: { default: null },
    });
    expect((schema.server?.properties as Record<string, object>).port).not.toHaveProperty(
      'minimum'
    );
  });
});

describe('repairWidenedLeaves', () => {
  const policy = relaxWidenedLeaves(fragment());

  it('returns its input by reference when there is nothing to repair', () => {
    const value = { theme: 'dark' };
    const result = repairWidenedLeaves('ui', value, policy);
    expect(result.value).toBe(value);
    expect(result.skewed).toEqual([]);
  });

  it('reports what it could not read alongside what it used instead', () => {
    const result = repairWidenedLeaves('ui', { theme: 'midnight' }, policy);
    expect(result.skewed).toEqual([{ path: 'ui.theme', stored: 'midnight', used: 'system' }]);
    expect(result.value).toEqual({ theme: 'system' });
  });

  it('repairs nothing the policy did not open', () => {
    // The policy is the only authority. A leaf Ajv still guards must not be
    // silently defaulted here instead — that would be two validators with
    // different opinions about the same file.
    const value = { theme: 'midnight' };
    const empty = relaxWidenedLeaves({});
    expect(repairWidenedLeaves('ui', value, empty).value).toBe(value);
  });

  it('repairs a leaf even when the section fails elsewhere', () => {
    // Per leaf, not per section: a problem the schema has somewhere else must
    // not suppress the fallback, and an unrecognized key beside it survives in
    // memory as well as on disk.
    const result = repairWidenedLeaves('ui', { theme: 'midnight', aKeyFromANewerBuild: 1 }, policy);
    expect(result.value).toEqual({ theme: 'system', aKeyFromANewerBuild: 1 });
  });

  it('ignores a section with no relaxed leaves', () => {
    const value = { anything: true };
    expect(repairWidenedLeaves('fromTheFuture', value, policy).value).toBe(value);
  });
});

describe('preserveWidenedLeaves', () => {
  const skewed = [{ path: 'ui.theme', stored: 'midnight', used: 'system' }];

  it('carries the stored value onto a write that did not name it', () => {
    expect(preserveWidenedLeaves(skewed, 'ui', { theme: 'system', composer: {} })).toEqual({
      theme: 'midnight',
      composer: {},
    });
  });

  it('lets a write that names it win', () => {
    const next = { theme: 'dark' };
    expect(preserveWidenedLeaves(skewed, 'ui', next)).toBe(next);
  });

  it('works when the write IS the leaf', () => {
    expect(preserveWidenedLeaves(skewed, 'ui.theme', 'system')).toBe('midnight');
    expect(preserveWidenedLeaves(skewed, 'ui.theme', 'dark')).toBe('dark');
  });

  it('ignores a write to a different path', () => {
    const next = { port: 4242 };
    expect(preserveWidenedLeaves(skewed, 'server', next)).toBe(next);
  });

  it('leaves a deletion alone', () => {
    // Absent is not "equal to what we handed out", so nothing is resurrected.
    const next = { composer: {} };
    expect(preserveWidenedLeaves(skewed, 'ui', next)).toBe(next);
  });
});
