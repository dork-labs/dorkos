/**
 * Settings written by a build that is not this one (DOR-1221).
 *
 * The defect these cover: the config schema closed every object, `conf`
 * validates on every read, and the recovery path read a schema violation as
 * corruption. So a key one build wrote and another build did not know about was
 * enough to back up the whole file and start again from defaults. It happened
 * five times on the machine DorkOS is developed on; the last one, verbatim from
 * the log, was `ui`, `ui/sidebar` (three times) and `runtimes/claudeCode`
 * complaining together.
 *
 * Every test here drives a REAL `ConfigManager` over a real file in a temp
 * directory, because the seam that broke is `conf`'s Ajv validation — a mock
 * store never reaches it, and `UserConfigSchema.parse` cannot stand in for it
 * either (Zod strips unknown keys where Ajv rejected them).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { ConfigManager, CONF_JSON_SCHEMA } from '../../config-manager.js';
import { preserveUnknownKeys, schemaNodeAt, tolerateUnknownKeys } from '../version-skew.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-skew-'));
  dirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(stored, null, 2));
  return { dir, configPath };
}

/** The config file as it stands on disk right now. */
function onDisk(configPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
}

/** Every backup of the config file, whatever it is named. */
function backupsIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.bak'));
}

describe('a config carrying keys this build does not declare', () => {
  it('boots, keeps the settings, and condemns nothing', () => {
    // The shape of the real incident: keys under three different sections at
    // once, alongside preferences and a protection the person had chosen.
    const { dir } = seed({
      version: 1,
      auth: { enabled: true },
      ui: {
        theme: 'dark',
        aSettingFromANewerBuild: 'whatever it wants',
        statusBar: { pins: ['permission'] },
        sidebar: { pinned: [], groups: [], sections: {}, muted: [], nextYearsPref: true },
      },
      runtimes: { default: 'claude-code', claudeCode: { anEntirelyNewOption: true } },
    });

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toEqual([]);
    expect(manager.get('ui').theme).toBe('dark');
    expect(manager.getDot('ui.statusBar.pins')).toEqual(['permission']);
    expect(manager.get('auth').enabled).toBe(true);
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('leaves those keys on disk for the build that owns them', () => {
    // Booting is only half of it: `conf` rewrites the file during an ordinary
    // boot, so tolerating a key on the way in and dropping it on the way out
    // would still lose the other build's settings.
    const { dir, configPath } = seed({
      version: 1,
      runtimes: { default: 'claude-code', claudeCode: { anEntirelyNewOption: true } },
    });

    new ConfigManager(dir, FAST_RETRIES);

    const runtimes = onDisk(configPath).runtimes as Record<string, Record<string, unknown>>;
    expect(runtimes.claudeCode?.anEntirelyNewOption).toBe(true);
  });

  it('keeps them through a write from the build that does not know them', () => {
    // The quiet version of the same data loss. Every write goes through Zod,
    // which strips what it does not declare, so an older build saving one
    // preference would delete the newer build's settings from the file.
    const { dir, configPath } = seed({
      version: 1,
      runtimes: { default: 'claude-code', claudeCode: { anEntirelyNewOption: true } },
      ui: { theme: 'system', sidebar: { nextYearsPref: true } },
    });

    const manager = new ConfigManager(dir, FAST_RETRIES);
    // Exactly what `applyConfigPatch` writes: the whole section, Zod-validated
    // and therefore Zod-stripped.
    const validated = UserConfigSchema.parse(manager.getAll());
    manager.set('runtimes', validated.runtimes);
    manager.set('ui', { ...validated.ui, theme: 'dark' });

    const stored = onDisk(configPath);
    const runtimes = stored.runtimes as Record<string, Record<string, unknown>>;
    const ui = stored.ui as Record<string, Record<string, unknown>>;
    expect(runtimes.claudeCode?.anEntirelyNewOption).toBe(true);
    expect(ui.sidebar?.nextYearsPref).toBe(true);
    // And the write itself still landed.
    expect(ui.theme).toBe('dark');
    expect(new ConfigManager(dir, FAST_RETRIES).get('ui').theme).toBe('dark');
  });

  it('boots a config holding a key a migration has retired but not yet removed', () => {
    // The other direction of the same skew, and the one that does not need two
    // builds at all: the schema drops a key, and every config written before
    // that release still has it until the migration runs — which it does not do
    // in a dev tree, where `SERVER_VERSION` is `0.0.0` and no migration is ever
    // selected.
    const { dir } = seed({
      version: 1,
      ui: { theme: 'dark', sidebar: { recentsExpandedCount: 12 } },
      auth: { enabled: true },
    });

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toEqual([]);
    expect(manager.get('ui').theme).toBe('dark');
    expect(manager.get('auth').enabled).toBe(true);
  });

  it('still condemns a file whose declared keys are wrong', () => {
    // The guard against tolerance becoming "validate nothing". `server.port`
    // exists and must be an integer, so this file really is unusable and the
    // recovery path is still the right answer.
    const { dir } = seed({ version: 1, server: { port: 'not-a-port' }, auth: { enabled: true } });

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toHaveLength(1);
    expect(manager.get('server').port).toBe(4242);
    // DOR-584 still holds on that path: a wipe may lose preferences, never a
    // protection.
    expect(manager.get('auth').enabled).toBe(true);
  });
});

describe('the schema conf validates against', () => {
  it('rejects no key merely for being unknown', () => {
    // A drift guard. The tolerance is applied once, to the generated schema, so
    // a regenerated or hand-edited schema that closes an object again would put
    // the whole defect straight back — silently, and only on the machines that
    // run more than one build.
    const closed: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${at}[${index}]`));
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'additionalProperties' && value === false) closed.push(at);
        walk(value, `${at}.${key}`);
      }
    };
    walk(CONF_JSON_SCHEMA, 'config');

    expect(closed).toEqual([]);
  });
});

describe('tolerateUnknownKeys', () => {
  it('opens closed objects wherever they are nested, and leaves record types alone', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        nested: { type: 'object', additionalProperties: false },
        listed: { type: 'array', items: { type: 'object', additionalProperties: false } },
        branch: { anyOf: [{ type: 'object', additionalProperties: false }] },
        record: { type: 'object', additionalProperties: { type: 'string' } },
      },
    };

    tolerateUnknownKeys(schema);

    expect(schema.additionalProperties).toBe(true);
    expect(schema.properties.nested.additionalProperties).toBe(true);
    expect(schema.properties.listed.items.additionalProperties).toBe(true);
    expect(schema.properties.branch.anyOf[0]!.additionalProperties).toBe(true);
    // A record's `additionalProperties` is a schema, not a refusal: the extra
    // keys are the data, and their shape is still worth checking.
    expect(schema.properties.record.additionalProperties).toEqual({ type: 'string' });
  });
});

describe('schemaNodeAt', () => {
  it('finds a declared object path and nothing else', () => {
    expect(schemaNodeAt(CONF_JSON_SCHEMA, 'runtimes')).toBeDefined();
    expect(schemaNodeAt(CONF_JSON_SCHEMA, 'runtimes.claudeCode')).toBeDefined();
    expect(schemaNodeAt(CONF_JSON_SCHEMA, 'runtimes.notAThing')).toBeUndefined();
    expect(schemaNodeAt(CONF_JSON_SCHEMA, 'notASection')).toBeUndefined();
    // A leaf has no `properties`, so nothing can be preserved under it.
    expect(schemaNodeAt(CONF_JSON_SCHEMA, 'runtimes.default.deeper')).toBeUndefined();
  });
});

describe('preserveUnknownKeys', () => {
  const node = {
    type: 'object',
    properties: {
      known: { type: 'string' },
      nested: { type: 'object', properties: { alsoKnown: { type: 'string' } } },
      record: { type: 'object', additionalProperties: { type: 'string' } },
    },
  };

  it('carries an unrecognized key across, at any depth', () => {
    const merged = preserveUnknownKeys(
      node,
      { known: 'old', theirs: 1, nested: { alsoKnown: 'old', alsoTheirs: 2 } },
      { known: 'new', nested: { alsoKnown: 'new' } }
    );

    expect(merged).toEqual({
      known: 'new',
      theirs: 1,
      nested: { alsoKnown: 'new', alsoTheirs: 2 },
    });
  });

  it('lets this build delete a key it does declare', () => {
    // Preservation must not resurrect a deliberate removal, or clearing a
    // setting would be impossible.
    expect(preserveUnknownKeys(node, { known: 'old' }, {})).toEqual({});
  });

  it('leaves records and arrays to the writer', () => {
    // Every key of a record is data the caller owns, so an absent one was
    // removed on purpose. Arrays are the same argument: position is not
    // identity.
    expect(
      preserveUnknownKeys(node, { record: { a: '1', b: '2' } }, { record: { a: '1' } })
    ).toEqual({ record: { a: '1' } });
    expect(preserveUnknownKeys(node, { known: ['a', 'b'] }, { known: ['a'] })).toEqual({
      known: ['a'],
    });
  });

  it('drops an unknown key nested inside an array item, and says so', () => {
    // The documented cost of the array carve-out, pinned rather than left to
    // the guide: `ui.sidebar.groups[]` and `runtimes.claudeCode.accounts[]` are
    // real instances. Matching stored items to written ones by index would be a
    // guess, and a wrong guess writes one person's setting onto another's row.
    const merged = preserveUnknownKeys(
      node,
      { known: [{ id: 'a', theirs: 1 }] },
      { known: [{ id: 'a' }] }
    );

    expect(merged).toEqual({ known: [{ id: 'a' }] });
  });

  it('returns its input untouched when there is nothing to carry', () => {
    // Referential equality, so the steady state costs nothing but the walk.
    const next = { known: 'new' };
    expect(preserveUnknownKeys(node, { known: 'old' }, next)).toBe(next);
    expect(preserveUnknownKeys(undefined, { theirs: 1 }, next)).toBe(next);
  });
});
