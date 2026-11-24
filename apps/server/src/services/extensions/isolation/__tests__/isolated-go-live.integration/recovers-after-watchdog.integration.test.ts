import {
  ID,
  NAME,
  sends,
  inbox,
  stoppedNotices,
  install,
  TEST_MS,
  boot,
  until,
  unexpectedStops,
  card,
  refuseStarts,
  extensionErrors,
  alive,
  get,
  post,
  st,
} from './harness.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { IsolatedExtensionHost } from '../../isolated-host.js';
import { logger } from '../../../../../lib/logger.js';
import type { ApiEnv } from '../../../../../http/api-chain.js';
import { registerExtensionRestartRoute } from '../../../../../routes/extensions-restart.js';

describe('an isolated extension goes live through the real lifecycle', () => {
  it(
    'recovers after a watchdog kill and a refused automatic self-check',
    async () => {
      await install();
      const attempts = refuseStarts((attempt) => attempt === 2);
      await boot(3, { pingIntervalMs: 100, pongTimeoutMs: 500 });
      const first = (await get(`/api/ext/${ID}/ping`)).body.pid;
      expect(first).toEqual(expect.any(Number));
      await post(`/api/ext/${ID}/hang`);
      await until(() => attempts() === 3, 10_000);
      await until(async () => (await get(`/api/ext/${ID}/ping`)).status === 200);
      expect((await get(`/api/ext/${ID}/ping`)).body.pid).not.toBe(first);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('self-check failed'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('isolation_unavailable'));
      expect((await extensionErrors()).count).toBe(0);
    },
    TEST_MS
  );

  it(
    'reports a refused initial start and its time without automatically retrying it',
    async () => {
      await install();
      const since = Date.now();
      const attempts = refuseStarts(() => true);
      await boot();
      const data = await extensionErrors();
      expect(data.count).toBe(1);
      expect(data.errors[0].serverError.code).toBe('isolation_unavailable');
      expect(Date.parse(data.errors[0].serverError.occurredAt)).toBeGreaterThanOrEqual(since);
      expect(st.manager.listErrors()[0].serverError).toEqual(data.errors[0].serverError);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(attempts()).toBe(1);
    },
    TEST_MS
  );

  it(
    'reports a refused retry during backoff and cancels it on an explicit stop',
    async () => {
      await install();
      const attempts = refuseStarts((attempt) => attempt > 1);
      await boot(3, { pingIntervalMs: 100, pongTimeoutMs: 500 }, [10, 1_000]);
      const since = Date.now();
      await post(`/api/ext/${ID}/hang`);
      await until(
        async () =>
          (await extensionErrors()).errors.some(
            (error: { serverError?: { code: string } }) =>
              error.serverError?.code === 'isolation_unavailable'
          ),
        10_000
      );
      const error = (await extensionErrors()).errors[0].serverError;
      expect(Date.parse(error.occurredAt)).toBeGreaterThanOrEqual(since);
      expect(card().restartingAt).toEqual(expect.any(String));
      expect(card().serverError).toBeUndefined();
      expect(attempts()).toBe(2);
      await st.manager.shutdownServer(ID);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(attempts()).toBe(2);
      expect(st.manager.getServerHandler(ID)).toBeNull();
      expect(card().restartingAt).toBeNull();
    },
    TEST_MS
  );

  it(
    'bounds refused automatic restarts and tells the person when it gives up',
    async () => {
      await install();
      const attempts = refuseStarts((attempt) => attempt > 1);
      await boot(3, { pingIntervalMs: 100, pongTimeoutMs: 500 });
      await post(`/api/ext/${ID}/hang`);
      await until(() => stoppedNotices().some((notice) => notice.tier === 'notable'));
      expect(attempts()).toBe(3);
      expect(st.manager.getServerHandler(ID)).toBeNull();
      expect((await extensionErrors()).errors[0].serverError.code).toBe('isolation_unavailable');
      expect((await st.manager.initializeServer(ID)).ok).toBe(false);
      expect(attempts()).toBe(3);
      expect(stoppedNotices().find((notice) => notice.tier === 'notable')).toMatchObject({
        title: `The ${NAME} app is off`,
        body: 'It couldn’t restart. Use Restart to try again.',
        actions: [{ id: 'restart-extension', label: 'Restart', style: 'primary' }],
      });
    },
    TEST_MS
  );

  it(
    'does not retry a compile failure using a previous isolation refusal',
    async () => {
      await install();
      const attempts = refuseStarts((attempt) => attempt === 2);
      await boot(5, { pingIntervalMs: 100, pongTimeoutMs: 500 }, [10, 1_000, 1_000]);
      await post(`/api/ext/${ID}/hang`);
      await until(
        async () =>
          (await extensionErrors()).errors.some(
            (error: { serverError?: { code: string } }) =>
              error.serverError?.code === 'isolation_unavailable'
          ),
        10_000
      );
      vi.spyOn(st.manager.getCompiler(), 'compileServer').mockResolvedValueOnce({
        sourceHash: 'synthetic-compile-failure',
        error: { code: 'compilation_failed', message: 'Synthetic compile failure', errors: [] },
      });
      await until(() => stoppedNotices().some((notice) => notice.tier === 'notable'), 10_000);
      expect(attempts()).toBe(2);
      expect((await extensionErrors()).errors[0].serverError.code).toBe('server_start_failed');
      expect(card().restartingAt).toBeNull();
    },
    TEST_MS
  );

  it(
    'counts a child that dies before mounting once and continues its existing backoff',
    async () => {
      await install();
      const realStart = IsolatedExtensionHost.prototype.start;
      let attempts = 0;
      vi.spyOn(IsolatedExtensionHost.prototype, 'start').mockImplementation(async function (
        this: IsolatedExtensionHost
      ) {
        attempts++;
        const result = await realStart.call(this);
        if (attempts === 2) {
          this.killNow();
          await this.stop();
        }
        return result;
      });
      await boot();
      await post(`/api/ext/${ID}/crash`);
      await until(() => attempts === 3, 10_000);
      await until(async () => (await get(`/api/ext/${ID}/ping`)).status === 200);
      expect(stoppedNotices().filter((notice) => notice.tier === 'notable')).toEqual([]);
      expect((await extensionErrors()).count).toBe(0);
    },
    TEST_MS
  );

  it(
    'leaves a non-isolation restart failure off with a reason and a Restart notice',
    async () => {
      await install();
      const attempts = refuseStarts(() => false);
      await boot(3, { pingIntervalMs: 100, pongTimeoutMs: 500 });
      vi.spyOn(st.manager.getCompiler(), 'compileServer').mockRejectedValueOnce(
        new Error('Synthetic automatic compile error')
      );
      await post(`/api/ext/${ID}/hang`);
      await until(() => stoppedNotices().some((notice) => notice.tier === 'notable'), 10_000);
      expect(attempts()).toBe(1);
      expect((await extensionErrors()).errors[0].serverError).toMatchObject({
        code: 'server_start_failed',
        message: expect.stringContaining('Synthetic automatic compile error'),
      });
      expect(stoppedNotices().find((notice) => notice.tier === 'notable')?.body).toBe(
        'It couldn’t restart. Use Restart to try again.'
      );
    },
    TEST_MS
  );

  // Purpose: approved and started, it answers through DorkOS from its own
  // process (not this one), and ctx crosses the boundary to the real store.
  it(
    'serves its router from its own process and uses ctx',
    async () => {
      await install();
      await boot();
      const ping = await get(`/api/ext/${ID}/ping`);
      expect(ping.status).toBe(200);
      expect(ping.body.version).toBe('v1');
      expect(ping.body.pid).not.toBe(process.pid);
      expect(st.manager.getServerHandler(ID)).not.toBeNull();
      const pid = ping.body.pid as number;
      expect(alive(pid)).toBe(true);

      const storedBack = await post(`/api/ext/${ID}/store`, { n: 7 });
      expect(storedBack.body).toEqual({ n: 7 });
      // The real ctx wrote it, under DorkOS's data directory, not the child's.
      const files = await fs.readdir(path.join(st.dorkHome, 'extension-data', ID));
      expect(files.length).toBeGreaterThan(0);
      expect(inbox.running).toContain(ID);
      expect(card().serverError).toBeUndefined();

      // A clean stop ends its process and leaves nothing to restart.
      await st.manager.shutdownServer(ID);
      expect(alive(pid)).toBe(false);
      expect(st.manager.getServerHandler(ID)).toBeNull();
      await new Promise((r) => setTimeout(r, 600));
      expect(st.manager.getServerHandler(ID)).toBeNull();
    },
    TEST_MS
  );

  // Purpose: a crash leaves DorkOS serving, runs the stop bookkeeping (the
  // message it was holding is failed, never delivered), shows "Restarting",
  // and a fresh process takes over on the backoff.
  it(
    'restarts after a crash, failing the message it was holding',
    async () => {
      await install();
      await boot();
      const first = (await get(`/api/ext/${ID}/ping`)).body.pid as number;
      await post(`/api/ext/${ID}/send`);
      await until(() => sends.held.length === 1);
      expect(sends.held[0]!.failed).toBeNull();

      await post(`/api/ext/${ID}/crash`);
      await until(() => !alive(first));
      expect((await get('/api/health')).body).toEqual({ ok: true });
      await until(() => sends.stopped.includes(ID) && inbox.stopped.includes(ID));
      expect(sends.held[0]!.failed).toBe('stopped');
      await until(() => unexpectedStops() === 1);
      expect(st.announced).toContain(ID);
      expect(st.shownAtBroadcast.find((c) => c.restartingAt)).toEqual({
        restartingAt: expect.any(String),
        serverError: undefined,
      });

      await until(async () => (await get(`/api/ext/${ID}/ping`)).status === 200);
      const second = (await get(`/api/ext/${ID}/ping`)).body.pid as number;
      expect(second).not.toBe(first);
      expect(card().restartingAt).toBeNull();
      expect(card().serverError).toBeUndefined();
    },
    TEST_MS
  );

  // Purpose: the third crash inside the window leaves it stopped with the
  // card's words; a page load's init does not start it again; a reload
  // does, with a fresh crash budget.
  it(
    'stays stopped after three crashes until it is reloaded',
    async () => {
      await install();
      await boot();
      for (let crash = 1; crash <= 3; crash++) {
        await until(async () => (await get(`/api/ext/${ID}/ping`)).status === 200);
        const pid = (await get(`/api/ext/${ID}/ping`)).body.pid as number;
        await post(`/api/ext/${ID}/crash`);
        await until(() => !alive(pid));
        await until(() => unexpectedStops() === crash);
      }
      await until(() => card().serverError?.code === 'server_crashed');
      expect(card().serverError?.message).toBe(
        `${NAME} stopped unexpectedly 3 times. Reload it to try again.`
      );
      // The person was told, by name: one "restarted" row for the first two
      // stops, then one "is off" row with Restart (DOR-4785).
      await until(() => stoppedNotices().length === 2);
      const [off, restarted] = stoppedNotices();
      expect(restarted).toMatchObject({
        tier: 'quiet',
        subject: { type: 'system', id: `extension:${ID}` },
        title: `The ${NAME} app stopped unexpectedly. DorkOS is restarting it.`,
      });
      expect(off).toMatchObject({
        tier: 'notable',
        subject: { type: 'system', id: `extension:${ID}` },
        title: `The ${NAME} app is off`,
        body: 'It stopped 3 times in 10 minutes, so DorkOS left it off.',
        actions: [{ id: 'restart-extension', label: 'Restart', style: 'primary' }],
      });
      await new Promise((r) => setTimeout(r, 700));
      expect(st.manager.getServerHandler(ID)).toBeNull();
      expect((await get(`/api/ext/${ID}/ping`)).status).toBe(404);

      // What every page load asks for: refused, still stopped.
      const init = await st.manager.initializeServer(ID);
      expect(init.ok).toBe(false);
      expect(st.manager.getServerHandler(ID)).toBeNull();

      const restart = new Hono<ApiEnv>();
      restart.use(async (c, next) => {
        c.set('user', { userId: 'owner', credential: 'cookie' });
        await next();
      });
      registerExtensionRestartRoute(restart, st.manager, /^[a-z0-9][a-z0-9-]*$/, () => {});
      const restartedResponse = await restart.request(
        `/${ID}/restart`,
        { method: 'POST' },
        {
          incoming: { headers: {}, socket: { remoteAddress: '127.0.0.1' }, method: 'POST' },
        }
      );
      expect(restartedResponse.status).toBe(200);
      expect((await get(`/api/ext/${ID}/ping`)).status).toBe(200);
      expect(card().serverError).toBeUndefined();
      // One explicit press gives one fresh three-stop budget. Nothing retries
      // the notice's action when the app stops again.
      const stopsBeforeRestart = unexpectedStops();
      for (let crash = 1; crash <= 3; crash++) {
        await until(async () => (await get(`/api/ext/${ID}/ping`)).status === 200);
        await post(`/api/ext/${ID}/crash`);
        await until(() => unexpectedStops() === stopsBeforeRestart + crash);
      }
      await until(() => card().serverError?.code === 'server_crashed');
      expect(st.manager.getServerHandler(ID)).toBeNull();
    },
    TEST_MS
  );
});
