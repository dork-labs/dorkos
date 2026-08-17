/**
 * The drift guard for `experiments-registry.ts`.
 *
 * An experiment is only an experiment while four things hold: the path it writes
 * exists, it is a boolean, it ships OFF, and something is tracking whether it
 * graduates. Each one has failed somewhere in this repo's history — a leaf
 * renamed out from under a table, a default flipped without its consumers moving,
 * a flag with nobody's name on it — so each is asserted here rather than trusted.
 */
import { describe, it, expect } from 'vitest';
import { UserConfigSchema, USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { EXPERIMENTS, type ExperimentEntry } from '../experiments-registry.js';
import { configSchemaLeaves } from '../../operator/config-disclosure.js';

/** Read a dot-path out of an object, or `undefined` if any hop is missing. */
function readAt(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * The default a leaf gets when its section is PRESENT but the leaf is absent.
 *
 * The section-level `.default(() => ({...}))` literal and the per-field
 * `.default(...)` are two live sources that can disagree, and it is the per-field
 * one every existing install observes on read (conf's Ajv fills it in). Both are
 * checked, for the reason `safe-defaults/__tests__/default-verdicts.test.ts`
 * spells out at length.
 */
function fieldLevelDefault(path: string): unknown {
  const [section, ...rest] = path.split('.');
  if (section === undefined || rest.length === 0) return readAt(USER_CONFIG_DEFAULTS, path);
  const parsed = UserConfigSchema.safeParse({ version: 1, [section]: {} });
  if (!parsed.success) return readAt(USER_CONFIG_DEFAULTS, path);
  return readAt(parsed.data, path);
}

/**
 * The assertions, factored out so the negative cases below can run them against a
 * fabricated registry and prove the guard actually discriminates.
 */
function auditEntry(entry: ExperimentEntry, leaves: Map<string, string>): string[] {
  const problems: string[] = [];
  const shape = leaves.get(entry.path);

  if (shape === undefined) {
    problems.push(`${entry.path}: not a leaf of UserConfigSchema`);
  } else if (shape !== 'scalar') {
    problems.push(`${entry.path}: resolves to ${shape}, not a scalar`);
  }

  if (shape !== undefined) {
    const objectLevel = readAt(USER_CONFIG_DEFAULTS, entry.path);
    const fieldLevel = fieldLevelDefault(entry.path);
    if (typeof objectLevel !== 'boolean') {
      problems.push(`${entry.path}: default is ${typeof objectLevel}, not a boolean`);
    }
    if (objectLevel !== false || fieldLevel !== false) {
      problems.push(
        `${entry.path}: ships ON (section default ${String(objectLevel)}, field default ${String(fieldLevel)}) — graduate it and delete the entry instead of offering a switch to turn it off`
      );
    }
  }

  if (entry.graduationIssue.trim() === '') {
    problems.push(`${entry.path}: no graduationIssue`);
  }

  return problems;
}

/** Leaf path -> shape, from the schema itself. */
function schemaLeaves(): Map<string, string> {
  return new Map(configSchemaLeaves().map((leaf) => [leaf.path, leaf.shape]));
}

describe('EXPERIMENTS', () => {
  const leaves = schemaLeaves();

  it('is a registry every entry of which is expected to be deleted, so empty is legal', () => {
    // Not a vacuous assertion: it pins the fact that this guard must keep passing
    // once the last experiment graduates. A guard that required at least one
    // entry would make the success state red.
    expect(Array.isArray(EXPERIMENTS)).toBe(true);
  });

  it('lists no path twice', () => {
    const paths = EXPERIMENTS.map((e) => e.path);
    expect(paths).toEqual([...new Set(paths)]);
  });

  it('every entry writes a real boolean leaf that ships OFF and names a graduation issue', () => {
    const problems = EXPERIMENTS.flatMap((entry) => auditEntry(entry, leaves));
    expect(problems).toEqual([]);
  });

  it('every entry carries prose a person can read', () => {
    for (const entry of EXPERIMENTS) {
      expect(entry.title.trim(), entry.path).not.toBe('');
      expect(entry.description.trim(), entry.path).not.toBe('');
      if (entry.costNote !== undefined) {
        expect(entry.costNote.trim(), entry.path).not.toBe('');
      }
    }
  });

  // ## The guard discriminates
  //
  // Three fabricated entries, one per failure the real registry could drift into.
  // Without these the assertions above would pass just as happily against a table
  // that had rotted, and a check that cannot fail is worse than no check.
  describe('rejects an entry that has drifted', () => {
    const base = { title: 't', description: 'd', graduationIssue: 'DOR-1' } as const;

    it('a path that is not in the schema at all', () => {
      const problems = auditEntry({ ...base, path: 'runtimes.claudeCode.notAThing' }, leaves);
      expect(problems).toEqual(['runtimes.claudeCode.notAThing: not a leaf of UserConfigSchema']);
    });

    it('a leaf that ships ON', () => {
      // `relay.enabled` really does default true (ADR-0171 graduated it), which
      // makes it the honest stand-in for an experiment whose default has flipped.
      const problems = auditEntry({ ...base, path: 'relay.enabled' }, leaves);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('ships ON');
    });

    it('a leaf that is not a boolean', () => {
      const problems = auditEntry({ ...base, path: 'server.port' }, leaves);
      expect(problems).toContain('server.port: default is number, not a boolean');
    });

    it('an entry with no graduation issue', () => {
      const problems = auditEntry({ ...base, path: 'a2a.enabled', graduationIssue: '  ' }, leaves);
      expect(problems).toEqual(['a2a.enabled: no graduationIssue']);
    });
  });
});
