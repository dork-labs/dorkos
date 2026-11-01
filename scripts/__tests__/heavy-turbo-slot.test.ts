/**
 * A bare `turbo build` takes a host-wide heavy-run slot (DOR-3274 Phase 2).
 *
 * Phase 1 wrapped the root `pnpm build`, `typecheck`, `test` and `verify`
 * scripts in scripts/heavy-run-lock.sh, but `turbo build` typed by hand, or run
 * by a test harness, a Playwright web server or an agent, went straight past
 * it. turbo has no pre-run hook, so the cap rides on the task graph instead:
 * every heavy task depends on the root task `//#heavy-slot`, which runs
 * scripts/heavy-turbo-slot.mjs once per invocation, and that takes a slot for
 * the turbo process's lifetime (`heavy-run-lock.sh --hold`).
 *
 * THE SILENT REGRESSIONS this pins:
 *
 *   * A new heavy task, or a package override of one (`@dorkos/x#test`
 *     REPLACES the generic task's `dependsOn`), drops the dependency. Nothing
 *     fails and that task runs uncapped.
 *   * The guard task loses `cache: false` and turbo replays it from cache
 *     without running it, or loses its pass-through env (strict mode) and no
 *     longer sees CI or the slot its own `pnpm build` parent holds.
 *   * A dev or watch run holds a slot until someone stops it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { exempt, findTurbo, longLived, persistentTasks } from '../heavy-turbo-slot.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

interface TurboTask {
  dependsOn?: string[];
  cache?: boolean;
  persistent?: boolean;
  passThroughEnv?: string[];
}
const turbo = JSON.parse(readFileSync(path.join(repoRoot, 'turbo.json'), 'utf8')) as {
  tasks: Record<string, TurboTask>;
};
const rootScripts = (
  JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

const HEAVY = ['build', 'typecheck', 'test', 'lint'];
const GUARD = '//#heavy-slot';

describe('turbo.json routes every heavy task through the slot guard', () => {
  const heavy = Object.entries(turbo.tasks).filter(([name]) =>
    HEAVY.includes(name.split('#').pop() ?? '')
  );

  it('finds the heavy tasks it claims to check', () => {
    expect(heavy.map(([name]) => name)).toEqual(expect.arrayContaining(HEAVY));
  });

  it.each(heavy.map(([name, task]) => [name, task] as const))(
    '%s depends on //#heavy-slot',
    (name, task) => {
      expect(
        task.dependsOn ?? [],
        `turbo.json's ${name} no longer depends on ${GUARD}, so \`turbo ${name.split('#').pop()}\` ` +
          'runs uncapped. Parallel full builds and typechecks panicked this host on 2026-10-24.'
      ).toContain(GUARD);
    }
  );

  it('no persistent task depends on the guard directly', () => {
    for (const [name, task] of Object.entries(turbo.tasks))
      if (task.persistent) expect(task.dependsOn ?? [], name).not.toContain(GUARD);
  });

  it('the guard always runs and sees the variables that exempt it', () => {
    const guard = turbo.tasks[GUARD];
    expect(guard?.cache).toBe(false);
    expect(guard?.passThroughEnv).toEqual(expect.arrayContaining(['CI', 'DORKOS_HEAVY_*']));
    expect(rootScripts['heavy-slot']).toBe('node scripts/heavy-turbo-slot.mjs');
  });
});

describe('heavy-turbo-slot.mjs', () => {
  it('is a no-op under CI, a switched-off cap, a held slot and on Windows', () => {
    expect(exempt({ CI: 'true' }, 'darwin')).toBe(true);
    expect(exempt({ CI: '1' }, 'linux')).toBe(true);
    expect(exempt({ DORKOS_HEAVY_LOCK: '0' }, 'darwin')).toBe(true);
    expect(exempt({ DORKOS_HEAVY_SLOT_HELD: '1' }, 'darwin')).toBe(true);
    expect(exempt({}, 'win32')).toBe(true);
  });

  it('takes a slot on a plain local run', () => {
    expect(exempt({}, 'darwin')).toBe(false);
    expect(exempt({ CI: '' }, 'linux')).toBe(false);
    expect(exempt({ CI: 'false' }, 'darwin')).toBe(false);
  });

  it('reads the persistent tasks from turbo.json', () => {
    const persistent = persistentTasks(turbo);
    expect(persistent).toEqual(expect.arrayContaining(['dev', 'test:watch']));
    expect(persistent).not.toContain('build');
  });

  it('lets a dev or watch run through without holding a slot for its life', () => {
    const persistent = persistentTasks(turbo);
    const bin = '/repo/node_modules/@turbo/darwin-arm64/bin/turbo';
    expect(longLived(`${bin} dev --filter=@dorkos/desktop`, persistent)).toBe(true);
    expect(longLived(`${bin} run dev`, persistent)).toBe(true);
    expect(longLived(`${bin} watch build`, persistent)).toBe(true);
    expect(longLived(`${bin} build`, persistent)).toBe(false);
    expect(longLived(`${bin} run build --filter=@dorkos/server^...`, persistent)).toBe(false);
    expect(longLived(`${bin} run typecheck lint --affected`, persistent)).toBe(false);
  });

  it('finds the nearest turbo ancestor, through pnpm and sh', () => {
    const tree: Record<number, { comm: string; ppid: number; args: string }> = {
      40: { comm: 'bash', ppid: 30, args: 'bash' },
      30: { comm: 'sh', ppid: 20, args: 'sh -c node scripts/heavy-turbo-slot.mjs' },
      20: {
        comm: '/repo/node_modules/@turbo/darwin-arm64/bin/turbo',
        ppid: 10,
        args: 'turbo build',
      },
      10: { comm: 'node', ppid: 1, args: 'node turbo build' },
    };
    const ps = (field: string, pid: number) => {
      const p = tree[pid];
      if (!p) return '';
      return String(field === 'comm' ? p.comm : field === 'ppid' ? p.ppid : p.args);
    };
    expect(findTurbo(40, ps)).toEqual({ pid: 20, args: 'turbo build' });
    expect(findTurbo(10, ps)).toBeNull();
    expect(findTurbo(999, ps)).toBeNull();
  });
});
