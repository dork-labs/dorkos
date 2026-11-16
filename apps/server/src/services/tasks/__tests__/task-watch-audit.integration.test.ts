/** Real watcher registration must belong to DorkOS, not the request that armed it. */
import chokidar from 'chokidar';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { currentAuditActor, runWithAuditActor } from '../../audit/audit-context.js';
import { TaskFileWatcher } from '../task-file-watcher.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { TaskRegistrar } from '../task-registrar.js';
import { TaskStore } from '../task-store.js';
import { FakeScheduler } from './fake-scheduler.js';
import { skillsRoot } from './task-root-fixtures.js';

const skill = (cron: string) =>
  `---\nname: native\ndescription: Native schedule\nschedule:\n  cron: '${cron}'\n---\nWork.`;
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= end) throw new Error('The real watcher did not register the schedule.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it('keeps native and recovery registrations outside the request that armed the real watcher', async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'task-watch-audit-')));
  const root = path.join(home, 'skills');
  const nativeDir = path.join(root, 'native');
  await mkdir(nativeDir, { recursive: true });
  const file = path.join(nativeDir, 'SKILL.md');
  await writeFile(file, skill('0 9 * * *'));
  const store = new TaskStore(createTestDb());
  const seen: { actor: unknown; cron: string | null }[] = [];
  class ObservedRegistrar extends TaskRegistrar {
    override syncTask(id: string): void {
      seen.push({ actor: currentAuditActor(), cron: store.getTask(id)?.cron ?? null });
      super.syncTask(id);
    }
    override repairTask(id: string): void {
      seen.push({ actor: currentAuditActor(), cron: store.getTask(id)?.cron ?? null });
      super.repairTask(id);
    }
  }
  const watcher = new TaskFileWatcher(
    store,
    new ObservedRegistrar({ store, scheduler: new FakeScheduler() }),
    new ScheduleIdentityRegistry()
  );
  const opened = vi.spyOn(chokidar, 'watch'); // Observe the real SDK object, without replacing it.
  try {
    await runWithAuditActor(
      { actor: { accountId: 'agent-a', kind: 'agent', name: 'Agent A' }, surface: 'mcp' },
      async () => {
        expect(currentAuditActor()?.actor.accountId).toBe('agent-a');
        watcher.watch(skillsRoot(root, 'global'));
        await watcher.ready();
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every(({ actor }) => actor === undefined)).toBe(true);
        seen.length = 0;

        // This directory was enrolled at startup: this edit exercises the native change path.
        await writeFile(file, skill('0 10 * * *'));
        await until(() => seen.some(({ cron }) => cron === '0 10 * * *'));
        expect(seen.every(({ actor }) => actor === undefined)).toBe(true);
        const beforeCue = seen.length;
        const native = opened.mock.results[0];
        if (native?.type !== 'return') throw new Error('The real watcher did not open.');
        const cue = once(native.value, 'addDir');
        // An empty directory cannot produce a task-file callback. Its cue re-scans the old file.
        await mkdir(path.join(root, 'directory-cue'));
        await cue;
        await until(() => seen.length > beforeCue);
        expect(seen.every(({ actor }) => actor === undefined)).toBe(true);
        expect(currentAuditActor()?.actor.accountId).toBe('agent-a');
      }
    );
  } finally {
    await watcher.stopAll();
    opened.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
});
