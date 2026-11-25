/**
 * The config migration check (DOR-5123). Each case in `fixtures/cases.json`
 * edits a small base shape and migrations table and states what must fail;
 * the walk and the table reader are tested on fixtures of their own, and the
 * CLI once over this repository, which keeps `shape.json` honest.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkConfigMigration, main, readWaivers, type Waiver } from '../check-config-migration.ts';
import { onlyWidened, shapeOf, type ConfigShape } from '../shape.ts';
import { pendingKeys, readMigrationTable } from '../../release/migration-table.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const BASE: ConfigShape = JSON.parse(fixture('base-shape.json'));
const MIGRATIONS = fixture('migrations.txt');

interface Case {
  name: string;
  set?: ConfigShape;
  delete?: string[];
  migrations?: [string, string][];
  baseWaivers?: Waiver[];
  headWaivers?: Waiver[];
  fails: string[];
}
const { cases } = JSON.parse(fixture('cases.json')) as { cases: Case[] };

describe('checkConfigMigration', () => {
  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const head = { ...BASE, ...entry.set };
    for (const path of entry.delete ?? []) delete head[path];
    let headMigrations = MIGRATIONS;
    for (const [from, to] of entry.migrations ?? []) {
      expect(headMigrations).toContain(from);
      headMigrations = headMigrations.replace(from, to);
    }
    const { findings } = checkConfigMigration({
      base: BASE,
      head,
      baseMigrations: MIGRATIONS,
      headMigrations,
      released: '0.20.0',
      baseWaivers: entry.baseWaivers ?? [],
      headWaivers: entry.headWaivers ?? [],
    });
    expect(findings).toHaveLength(entry.fails.length);
    entry.fails.forEach((start, index) => expect(findings[index]).toContain(start));
  });

  it('compares nothing when the base predates the shape file', () => {
    const input = { baseMigrations: null, headMigrations: MIGRATIONS, released: '0.20.0' };
    const result = checkConfigMigration({
      ...input,
      base: null,
      head: {},
      baseWaivers: [],
      headWaivers: [],
    });
    expect(result.findings).toEqual([]);
  });
});

describe('the shape walk', () => {
  it('names every path, its values, its default and whether a file may omit it', () => {
    expect(shapeOf(JSON.parse(fixture('walk-schema.json')))).toEqual(
      JSON.parse(fixture('walk-shape.json'))
    );
  });

  it('refuses a node it cannot follow rather than skipping it', () => {
    expect(() => shapeOf({ type: 'object', properties: { a: { $ref: '#/x' } } })).toThrow(
      /a: uses "\$ref"/
    );
  });

  it('reads a widening as free and a narrowing as not', () => {
    expect(onlyWidened('integer (default)', 'number | null (default)')).toBe(true);
    expect(onlyWidened('"a" | "b"', 'string')).toBe(true);
    expect(onlyWidened('string | undefined', 'string')).toBe(false);
    expect(onlyWidened('number', 'integer')).toBe(false);
  });
});

describe('the migrations table, read as text', () => {
  it('reads every key in order, with comments removed from the code', () => {
    const entries = readMigrationTable(MIGRATIONS);
    expect(entries.map((entry) => entry.key)).toEqual(['1.0.0', '0.20.0', '0.21.0']);
    expect(entries[2]?.code).not.toContain('Seeds the theme');
    expect(pendingKeys(entries, '0.20.0')).toEqual(['0.21.0']);
  });

  it('refuses a table it cannot read exactly', () => {
    expect(() => readMigrationTable('const x = 1;')).toThrow(/no `export const/);
    expect(() => readMigrationTable(MIGRATIONS.replace("'0.20.0'", "'0.20'"))).toThrow(/X\.Y\.Z/);
    expect(() =>
      readMigrationTable(MIGRATIONS.replace("  '0.20.0': seedComposer,", '  ...older,'))
    ).toThrow(/not a quoted key/);
    expect(() => readMigrationTable(MIGRATIONS.replace("'0.21.0'", "'0.20.0'"))).toThrow(/repeats/);
  });

  it('keeps the legacy sentinel out of the pending keys only while it leads the table', () => {
    const moved = MIGRATIONS.replace("  '1.0.0'", "  '0.1.0'").replace(
      '} as const;',
      "  '1.0.0': last,\n} as const;"
    );
    expect(pendingKeys(readMigrationTable(moved), '0.20.0')).toEqual(['0.21.0', '1.0.0']);
  });
});

describe('the waiver file', () => {
  it('refuses an entry a reviewer could not check', () => {
    const one = (entry: object) => JSON.stringify({ waivers: [entry] });
    expect(() => readWaivers(one({ path: 'a', change: 'added', reason: 'fine' }), 'w')).toThrow(
      /four words/
    );
    expect(() => readWaivers(one({ path: 'a', change: 'moved', reason: 'a b c d' }), 'w')).toThrow(
      /"change"/
    );
    expect(readWaivers(fixture('../../no-migration.json'), 'committed')).toEqual([]);
  });
});

describe('the CLI over this repository', () => {
  it('finds the committed shape current and the tree covered against HEAD', () => {
    expect(main(['--base', 'HEAD'])).toBe(0);
  });
});
