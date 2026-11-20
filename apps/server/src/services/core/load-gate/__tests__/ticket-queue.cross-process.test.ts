/**
 * Two separate processes share one load-gate queue folder (DOR-4209) and start
 * their jobs one at a time, in the order they joined the line.
 *
 * Each child is a real Node process running the real queue through `tsx`, the
 * pattern `lib/__tests__/shutdown-conf.test.ts` uses. This test holds the only
 * slot while both children join, so neither can start until it lets go, and the
 * order they start in can only come from the queue. It also checks this
 * process's view of the children's tickets, which goes through the real `ps`
 * start-time check.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCeilingMs, loadScaledMs } from '@dorkos/shared/test-budget';
import { TicketQueue } from '../ticket-queue.js';

const queueModule = new URL('../ticket-queue.ts', import.meta.url).href;
const children: ChildProcess[] = [];
const dirs: string[] = [];
const TEST_TIMEOUT_MS = Math.min(loadCeilingMs(30_000), 120_000);

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Start a child that joins the line, says so, and once it gets the slot writes
 * `start <name>`, holds it briefly, writes `end <name>` and gives it back.
 */
async function launch(name: string, dir: string, record: string): Promise<ChildProcess> {
  const source = `
    import { appendFileSync } from 'node:fs';
    import { TicketQueue } from ${JSON.stringify(queueModule)};
    const queue = new TicketQueue({ dir: ${JSON.stringify(dir)} });
    const ticket = queue.enqueue({ job: 'pnpm' });
    process.stdout.write('ENQUEUED\\n');
    const timer = setInterval(() => {
      // Beat, and rejoin if the ticket went missing, as the gate does on every poll.
      queue.beat(ticket);
      let result = queue.tryAcquire(ticket, { slots: 1, load: 0, maxLoad: 100 });
      if (result === 'lost') {
        queue.rejoin(ticket);
        result = queue.tryAcquire(ticket, { slots: 1, load: 0, maxLoad: 100 });
      }
      if (result !== 'slot') return;
      clearInterval(timer);
      appendFileSync(${JSON.stringify(record)}, 'start ${name}\\n');
      // The hold is what the other child must wait out; its length does not decide the order.
      setTimeout(() => {
        appendFileSync(${JSON.stringify(record)}, 'end ${name}\\n');
        queue.release(ticket);
        process.exit(0);
      }, 50);
    }, 20);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (chunk) => (stderr += String(chunk)));
  const lines = createInterface({ input: child.stdout! });
  const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(loadScaledMs(15_000)) });
  expect(line, stderr).toBe('ENQUEUED');
  return child;
}

describe('one queue across processes', () => {
  it(
    'starts two processes’ jobs one at a time, in the order they joined',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-load-gate-xproc-'));
      dirs.push(dir);
      const record = path.join(dir, 'order.log');
      const queue = new TicketQueue({ dir });
      const mine = queue.enqueue({ job: 'tsc' });
      expect(queue.tryAcquire(mine, { slots: 1, load: 0, maxLoad: 100 })).toBe('slot');
      // Keep this test's slot beating while the children start, which can outlast the lease
      // on a loaded machine.
      const beating = setInterval(() => queue.beat(mine), 1_000).unref();

      const first = await launch('A', dir, record);
      const second = await launch('B', dir, record);
      // Both children's tickets are live to this process, through the real `ps` check.
      expect(queue.list().map((ticket) => ticket.pid)).toEqual([first.pid, second.pid]);

      const exits = Promise.all([once(first, 'exit'), once(second, 'exit')]);
      clearInterval(beating);
      queue.release(mine);
      const [[firstCode], [secondCode]] = await exits;
      expect([firstCode, secondCode]).toEqual([0, 0]);
      expect(fs.readFileSync(record, 'utf8').trim().split('\n')).toEqual([
        'start A',
        'end A',
        'start B',
        'end B',
      ]);
      expect(queue.runningCount()).toBe(0);
      expect(queue.list()).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );
});
