/** Real watcher registration must belong to DorkOS, not the request that armed it. */
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { loadCeilingMs, loadScaledMs } from '@dorkos/shared/test-budget';
import { watchWithPolling } from '../../../__tests__/watch-with-polling.js';
import { currentAuditActor, runWithAuditActor } from '../../audit/audit-context.js';
import { TaskFileWatcher } from '../task-file-watcher.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { TaskRegistrar } from '../task-registrar.js';
import { TaskStore } from '../task-store.js';
import { FakeScheduler } from './fake-scheduler.js';
import { skillsRoot } from './task-root-fixtures.js';

const skill = (cron: string) =>
  `---\nname: native\ndescription: Native schedule\nschedule:\n  cron: '${cron}'\n---\nWork.`;
/** Wait for `check`, on a budget widened by the machine's load as the wait starts. */
async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + loadScaledMs(3000);
  while (!check()) {
    if (Date.now() >= end) throw new Error(`The real watcher did not ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The watch POLLS (`watchWithPolling`): macOS drops native events under load,
// and this case reddened healthy code on exactly that (DOR-2021). The real
// chokidar object, production's options and its handlers are all still used.
it(
  'keeps native and recovery registrations outside the request that armed the real watcher',
  { timeout: Math.min(loadCeilingMs(10_000), 60_000) },
  async () => {
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
    const polling = watchWithPolling(50);
    // Registered first, so a `stopAll` that throws below cannot leak the spy.
    onTestFinished(() => polling.restore());
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
          await until(() => seen.some(({ cron }) => cron === '0 10 * * *'), 'register the edit');
          expect(seen.every(({ actor }) => actor === undefined)).toBe(true);
          const beforeCue = seen.length;
          const [native] = polling.opened;
          if (!native) throw new Error('The real watcher did not open.');
          const cueDir = path.join(root, 'directory-cue');
          const cues: string[] = [];
          native.on('addDir', (dir: string) => cues.push(dir));
          // An empty directory cannot produce a task-file callback. Its cue re-scans the old file.
          await mkdir(cueDir);
          await until(() => cues.includes(cueDir), 'report the directory cue');
          await until(() => seen.length > beforeCue, 'rescan after the cue');
          expect(seen.every(({ actor }) => actor === undefined)).toBe(true);
          expect(currentAuditActor()?.actor.accountId).toBe('agent-a');
        }
      );
    } finally {
      await watcher.stopAll();
      await rm(home, { recursive: true, force: true });
    }
  }
);
