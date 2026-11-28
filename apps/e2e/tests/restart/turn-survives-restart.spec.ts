import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ChatRun } from '@dorkos/shared/run-schemas';
import type { HistoryMessage } from '@dorkos/shared/types';
import { makeThrowawayHome, serverEnvOnThrowawayHome } from '../../throwaway-home';

/**
 * A real kill of the server loses no accepted turn (spec
 * `turns-survive-restarts` §8, Tier B; DOR-5224).
 *
 * Tier A (`apps/server/src/services/runs/__tests__/restart-matrix*.test.ts`)
 * proves the rules over one process with a fake clock. This proves the same
 * promise the way it breaks in life: a server process killed with `SIGKILL`,
 * so no shutdown path runs, and a second process started on the same data
 * folder. Everything is read back over HTTP.
 *
 * The story: a person's turn is working (`long-turn`), they send a second
 * message, which waits behind it, and the server dies. After the restart:
 *
 * - the turn that died reads `process_died`, with the "continued" line;
 * - a continuation run (attempt 2, opened by recovery) runs and completes,
 *   before anything else in the chat;
 * - the waiting message runs once, and the dead turn's words are never sent
 *   again.
 *
 * WHY THE PROJECT, NOT THE LEGS. This spec starts its own server and kills it,
 * so it cannot share a leg: the `restart` project in `playwright.config.ts`
 * holds it alone. It drives no browser and no model; the server runs the
 * scripted test runtime (`DORKOS_TEST_RUNTIME=true`) on a throwaway home.
 *
 * WHY IT IS SLOW. A run another boot owned is dead only once its lease runs out
 * (§7.1, `RUN_LEASE_MS`, a minute), and the new boot's worker takes another
 * look just after that (`EffectWorker.start`). So recovery acts about a minute
 * after the second boot, by design: a server cannot tell a dead owner from a
 * slow one any sooner.
 */

/** The server package, whose `src/index.ts` is the entry both boots run. */
const SERVER_DIR = join(import.meta.dirname, '..', '..', '..', 'server');

/** How long one boot may take to answer `/api/health`. CI boots from source. */
const BOOT_MS = 120_000;

/** The lease (a minute) plus the worker's look after it, plus room for a slow runner. */
const RECOVERY_MS = 150_000;

/**
 * A run's lease (`RUN_LEASE_MS` in `services/runs/run-store.ts`). The second
 * boot has to be watching before the dead run's lease runs out, or recovery
 * may decide it before anything can see it.
 */
const LEASE_MS = 60_000;

/** How long a step that should be quick may take: a send, a queued row, a scripted turn. */
const STEP_MS = 20_000;

/** The statuses of a run that is over. */
const FINISHED: ReadonlySet<string> = new Set(['ended', 'settled', 'cancelled']);

const FIRST_WORDS = 'Migrate the auth tokens table';
const QUEUED_WORDS = 'then update the docs';

/** One running server process this spec started, and where it listens. */
interface OwnServer {
  child: ChildProcess;
  origin: string;
}

/** A free TCP port on this machine. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port'))
      );
    });
  });
}

/**
 * Start the server entry on `dorkHome`, as one process whose pid is the server:
 * `node --import tsx`, not the `tsx` command, which runs the server in a child
 * of its own and would leave that child alive when its parent is killed.
 *
 * @param started - Every process this spec starts goes here before anything
 *   can fail, so the cleanup stops it even when it never answered.
 */
async function boot(
  dorkHome: string,
  port: number,
  log: string,
  started: OwnServer[]
): Promise<OwnServer> {
  const fd = openSync(log, 'a', 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', fd, fd],
    env: {
      // eslint-disable-next-line no-restricted-syntax -- the spawned server needs the runner's PATH and nothing else of its environment
      PATH: process.env.PATH,
      // eslint-disable-next-line no-restricted-syntax -- the same: where temporary files go on this machine
      TMPDIR: process.env.TMPDIR,
      ...serverEnvOnThrowawayHome(dorkHome),
      DORK_HOME: dorkHome,
      DORKOS_PORT: String(port),
      DORKOS_TEST_RUNTIME: 'true',
      // The same locks every API leg sets (`playwright.config.ts`).
      DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
      DORKOS_NO_ROOM_INTRODUCTIONS: 'true',
    },
  });
  closeSync(fd);
  // `localhost`, as the server binds it by default (`DORKOS_HOST`).
  const origin = `http://localhost:${port}`;
  const server = { child, origin };
  started.push(server);
  await expect
    .poll(
      async () => {
        if (child.exitCode !== null) throw new Error(`The server exited early; see ${log}`);
        return fetch(`${origin}/api/health`)
          .then((res) => res.ok)
          .catch(() => false);
      },
      { timeout: BOOT_MS, intervals: [500], message: `the server never answered on ${origin}` }
    )
    .toBe(true);
  return server;
}

/** Wait for a process this spec started to be gone. */
async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once('exit', resolve));
}

/** Stop a server this spec started, politely first. Never another process. */
async function stop({ child }: OwnServer): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([exited(child), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited(child);
}

/** A chat's runs, as `GET /api/sessions/:id/runs` reads them. */
async function runsOf(
  request: APIRequestContext,
  origin: string,
  sessionId: string
): Promise<ChatRun[]> {
  const res = await request.get(`${origin}/api/sessions/${sessionId}/runs`);
  if (!res.ok()) throw new Error(`Reading the runs answered ${res.status()}: ${await res.text()}`);
  return ((await res.json()) as { runs: ChatRun[] }).runs;
}

/** A chat's transcript, as `GET /api/sessions/:id/messages` reads it. */
async function historyOf(
  request: APIRequestContext,
  origin: string,
  sessionId: string,
  cwd: string
): Promise<HistoryMessage[]> {
  const res = await request.get(
    `${origin}/api/sessions/${sessionId}/messages?cwd=${encodeURIComponent(cwd)}`
  );
  if (!res.ok()) throw new Error(`Reading the transcript answered ${res.status()}`);
  return ((await res.json()) as { messages: HistoryMessage[] }).messages;
}

/**
 * Every list of runs the chat's event stream (`GET /api/sessions/:id/events`)
 * carries while it is open: the snapshot's, then each `run_update`'s.
 *
 * Read from the stream because the runs list shows the run that ended last
 * only while nothing is live, and a continuation starts within a tick of the
 * decision. The stream carries every change, in order, so the moment the dead
 * run reads `process_died` is there to read however fast what follows it is.
 *
 * @param seen - Where each list goes as it arrives.
 * @returns A function that closes the stream.
 */
function watchRuns(origin: string, sessionId: string, cwd: string, seen: ChatRun[][]) {
  const abort = new AbortController();
  const done = (async () => {
    const res = await fetch(
      `${origin}/api/sessions/${sessionId}/events?cwd=${encodeURIComponent(cwd)}`,
      { headers: { accept: 'text/event-stream' }, signal: abort.signal }
    );
    if (!res.ok || !res.body) throw new Error(`The event stream answered ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length))
          .join('\n');
        if (data === '') continue;
        const event = JSON.parse(data) as { type?: string; runs?: ChatRun[] };
        if (Array.isArray(event.runs)) seen.push(event.runs);
      }
    }
  })().catch((err: unknown) => {
    if (!abort.signal.aborted) throw err;
  });
  return async () => {
    abort.abort();
    await done;
  };
}

/** Every reading of one run, oldest first. */
function readingsOf(seen: ChatRun[][], runId: string): ChatRun[] {
  return seen.flatMap((runs) => runs.filter((run) => run.id === runId));
}

test.describe('a real kill of the server', () => {
  test('loses no accepted turn: the dead turn is continued once, and the waiting message runs once', async ({
    request,
  }, testInfo) => {
    test.setTimeout(BOOT_MS * 2 + RECOVERY_MS + 60_000);

    // A throwaway data folder, outside the checkout, with the server's own home inside it.
    const dorkHome = mkdtempSync(join(tmpdir(), 'dorkos-restart-'));
    execFileSync('sh', ['-c', makeThrowawayHome(dorkHome)]);
    const log = join(dorkHome, 'server.log');
    const port = await freePort();
    const sessionId = randomUUID();
    const started: OwnServer[] = [];
    /** Every runs list the second boot's event stream carried. */
    const seen: ChatRun[][] = [];
    let agentDir: string | undefined;

    try {
      // ── The first boot: a working turn, and a message waiting behind it ──
      const bootedAt = Date.now();
      const firstBoot = await boot(dorkHome, port, log, started);
      const firstBootMs = Date.now() - bootedAt;
      const first = firstBoot.origin;
      const seeded = await request.post(`${first}/api/test/seed-agent`, {
        data: { instance: `restart-${sessionId.slice(0, 8)}` },
      });
      expect(seeded.ok(), await seeded.text()).toBe(true);
      ({ agentDir } = (await seeded.json()) as { agentDir: string });
      const cwd = agentDir!;

      // A turn that keeps working until something ends it. Only this chat's,
      // and only in this boot: the scenario store lives in memory, so after
      // the restart the chat answers with the default `simple-text`, which
      // echoes what it was sent.
      await request.post(`${first}/api/test/scenario`, {
        data: { name: 'long-turn', sessionId },
      });
      const send = (origin: string, content: string) =>
        request.post(`${origin}/api/sessions/${sessionId}/messages`, {
          data: { content, cwd, agentPath: cwd, create: true },
        });

      expect((await send(first, FIRST_WORDS)).status()).toBe(202);
      await expect
        .poll(async () => (await runsOf(request, first, sessionId)).map((run) => run.status), {
          timeout: STEP_MS,
          message: 'the first turn never reached its runtime',
        })
        .toEqual(['running']);
      const runningAt = Date.now();
      const [dying] = await runsOf(request, first, sessionId);

      expect((await send(first, QUEUED_WORDS)).status()).toBe(202);
      await expect
        .poll(async () => (await runsOf(request, first, sessionId)).map((run) => run.status), {
          timeout: STEP_MS,
          message: 'the second message never waited behind the first turn',
        })
        .toEqual(['running', 'queued']);
      const waiting = (await runsOf(request, first, sessionId))[1]!;
      expect(waiting.queueMessageId).not.toBeNull();

      // ── The kill: SIGKILL to the pid this spec started, so nothing shuts down ──
      const { child } = firstBoot;
      expect(child.pid).toBeDefined();
      process.kill(child.pid!, 'SIGKILL');
      await exited(child);
      expect(child.signalCode).toBe('SIGKILL');

      // ── The second boot, on the same data folder ──
      const killedAt = Date.now();
      const { origin: second } = await boot(dorkHome, port, log, started);
      const stopWatching = watchRuns(second, sessionId, cwd, seen);
      const watchingAfterMs = Date.now() - runningAt;
      testInfo.annotations.push({
        type: 'timing',
        description:
          `first boot ${firstBootMs} ms, second boot ${Date.now() - killedAt} ms, ` +
          `watching ${watchingAfterMs} ms after the turn started (its lease runs ${LEASE_MS} ms)`,
      });
      try {
        expect(
          watchingAfterMs,
          'the second boot came up after the dead run’s lease ran out, so recovery could act before anything watched'
        ).toBeLessThan(LEASE_MS);
        // The waiting message is still there, and nothing jumped the dead
        // turn while its lease runs out.
        expect((await runsOf(request, second, sessionId)).map((run) => run.id)).toEqual([
          dying!.id,
          waiting.id,
        ]);

        // Recovery decides the dead turn, a continuation runs, then the
        // waiting message: done when the waiting message's run has ended and
        // nothing in the chat is live or waiting.
        await expect
          .poll(
            async () => ({
              waitingEnded: readingsOf(seen, waiting.id).some((run) => run.ending !== null),
              open: (await runsOf(request, second, sessionId))
                .filter((run) => !FINISHED.has(run.status))
                .map((run) => run.id),
            }),
            {
              timeout: RECOVERY_MS,
              intervals: [1_000],
              message: 'the chat never settled after the restart',
            }
          )
          .toEqual({ waitingEnded: true, open: [] });
      } finally {
        await stopWatching();
      }

      // The dead turn reads `process_died`, with the line that says it goes on.
      expect(readingsOf(seen, dying!.id)).toContainEqual(
        expect.objectContaining({
          status: expect.stringMatching(/^(ended|settled)$/),
          ending: 'process_died',
          notice: 'restart_continued',
        })
      );

      // Exactly one continuation: attempt 2, opened by recovery, completed.
      const continuations = [
        ...new Set(
          seen
            .flat()
            .filter((run) => run.openedBy === 'recovery')
            .map((run) => run.id)
        ),
      ];
      expect(continuations).toHaveLength(1);
      const continuation = readingsOf(seen, continuations[0]!);
      expect(continuation.at(-1)).toMatchObject({ attempt: 2, ending: 'completed' });

      // Nothing jumped ahead of it: the continuation started before the
      // waiting message did, and the waiting message started once, as itself.
      const startOf = (readings: ChatRun[]) =>
        Date.parse(readings.find((run) => run.startedAt !== null)!.startedAt!);
      const waited = readingsOf(seen, waiting.id);
      expect(startOf(continuation)).toBeLessThanOrEqual(startOf(waited));
      expect(new Set(waited.map((run) => run.startedAt).filter(Boolean)).size).toBe(1);
      expect(waited.at(-1)).toMatchObject({ attempt: 1, ending: 'completed' });

      // The transcript says the same, in words: the continuation and the
      // waiting message each ran once, and the dead turn's words were never
      // sent again (after the restart the chat echoes whatever it is sent).
      const history = await historyOf(request, second, sessionId, cwd);
      const said = (role: HistoryMessage['role'], text: string) =>
        history.filter((message) => message.role === role && message.content.includes(text)).length;
      expect(said('user', 'DorkOS restarted while you were working')).toBe(1);
      expect(said('assistant', 'Echo: DorkOS restarted while you were working')).toBe(1);
      expect(said('user', QUEUED_WORDS)).toBe(1);
      expect(said('assistant', `Echo: ${QUEUED_WORDS}`)).toBe(1);
      expect(said('user', FIRST_WORDS)).toBeLessThanOrEqual(1);
      expect(said('assistant', `Echo: ${FIRST_WORDS}`)).toBe(0);
    } catch (err) {
      await testInfo.attach('server.log', { body: readFileSync(log), contentType: 'text/plain' });
      await testInfo.attach('runs-seen.json', {
        body: JSON.stringify(seen, null, 2),
        contentType: 'application/json',
      });
      throw err;
    } finally {
      for (const server of started) await stop(server);
      rmSync(dorkHome, { recursive: true, force: true });
      if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
