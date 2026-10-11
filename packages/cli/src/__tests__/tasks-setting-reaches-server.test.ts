import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The server lets `DORKOS_TASKS_ENABLED` overrule the saved `scheduler.enabled`
 * setting whenever the variable is PRESENT, and reports the Scheduled runs
 * switch as locked then. So the CLI may set it only for an explicit `--tasks` /
 * `--no-tasks`, never from the setting: when it copied the setting into the
 * variable, every CLI install with scheduled runs on looked env-locked
 * (DOR-2516; the relay twin is `relay-setting-reaches-server.test.ts`).
 * `cli.ts` is a top-level script with no importable entry, so this reads it.
 */
describe('CLI and the scheduled-runs setting', () => {
  const source = readFileSync(fileURLToPath(new URL('../cli.ts', import.meta.url)), 'utf8');

  it('writes DORKOS_TASKS_ENABLED only from the --tasks flag', () => {
    const writes = [
      ...source.matchAll(
        /process\.env(?:\.DORKOS_TASKS_ENABLED|\[['"]DORKOS_TASKS_ENABLED['"]\])\s*=[^=][^\n]*/g
      ),
    ].map((m) => m[0]);
    expect(writes).toEqual(["process.env.DORKOS_TASKS_ENABLED = values.tasks ? 'true' : 'false';"]);
  });

  it('never reads scheduler.enabled, which the server reads for itself', () => {
    expect(source).not.toMatch(/['"]scheduler\.enabled['"]/);
  });
});
