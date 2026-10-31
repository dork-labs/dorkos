/**
 * The turbo `inputs` that let this package's hash see the files its tests read.
 *
 * The census, the canary ref guard and the ledger tests read `.github/workflows/`,
 * `ci/` and `lefthook.yml`, none of which belong to `@dorkos/ci-steward`. Without
 * the `@dorkos/ci-steward#test` override in `turbo.json`, a change to a workflow
 * alone changes nothing this task hashes: a local turbo run replays a cached
 * green over it, and a pull request picking its suites by hash would skip this
 * one (ledger 261031-164516, DOR-3518). Dropping an entry is invisible in every
 * other way, so this file is what keeps them there.
 *
 * @module __tests__/turbo-inputs
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The repository root, four levels above this file. */
const ROOT = resolve(import.meta.dirname, '../../../..');

/** The fields of a turbo task definition this guard reads. */
interface TurboTask {
  /** What must build before the task runs. */
  dependsOn?: string[];
  /** Whether turbo may replay a previous run. */
  cache?: boolean;
  /** The file set the task's hash is computed over. */
  inputs?: string[];
}

/** `turbo.json`, parsed. */
function tasks(): Record<string, TurboTask> {
  const parsed = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8')) as {
    tasks?: Record<string, TurboTask>;
  };
  return parsed.tasks ?? {};
}

describe('@dorkos/ci-steward#test hashes the files its tests read', () => {
  it('declares the workflows, ci/ and the hooks beside its own files', () => {
    const inputs = tasks()['@dorkos/ci-steward#test']?.inputs ?? [];
    expect(inputs).toEqual(
      expect.arrayContaining([
        '$TURBO_DEFAULT$',
        '$TURBO_ROOT$/ci/**',
        '$TURBO_ROOT$/.github/workflows/**',
        '$TURBO_ROOT$/lefthook.yml',
      ])
    );
  });

  it('restates what the base test task declares, since an override replaces it', () => {
    const all = tasks();
    expect(all.test?.dependsOn).toEqual(['^build']);
    expect(all['@dorkos/ci-steward#test']?.dependsOn).toEqual(all.test?.dependsOn);
    expect(all['@dorkos/ci-steward#test']?.cache).toBe(all.test?.cache);
  });

  it('every package-scoped test override keeps its own files hashed', () => {
    // A package-scoped `inputs` REPLACES the default set, so one without
    // `$TURBO_DEFAULT$` would stop hashing the package's own source.
    const overrides = Object.entries(tasks()).filter(
      ([id, task]) => id.endsWith('#test') && task.inputs
    );
    expect(overrides.length).toBeGreaterThanOrEqual(9);
    const missing = overrides
      .filter(([, task]) => !task.inputs!.includes('$TURBO_DEFAULT$'))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });
});
