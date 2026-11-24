import {
  stored,
  agentLevel,
  ID,
  NAME,
  serverSource,
  sends,
  stoppedNotices,
  install,
  TEST_MS,
  boot,
  until,
  unexpectedStops,
  card,
  extensionErrors,
  alive,
  get,
  post,
  st,
} from './harness.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { placeSnapshots } from '../../../pin/extension-snapshot-placement.js';

describe('an isolated extension goes live through the real lifecycle', () => {
  // Purpose: new code is a fresh start however it arrives. Two crashes,
  // then a new server.ts reached through a plain page-load init (no
  // reload, no reset): its first crash restarts it instead of being the
  // third strike.
  it(
    'gives new code a fresh crash budget',
    async () => {
      await install('v1');
      await boot();
      for (let crash = 1; crash <= 2; crash++) {
        await until(async () => (await get(`/api/ext/${ID}/ping`)).status === 200);
        const pid = (await get(`/api/ext/${ID}/ping`)).body.pid as number;
        await post(`/api/ext/${ID}/crash`);
        await until(() => !alive(pid));
        await until(() => unexpectedStops() === crash);
      }
      await until(async () => (await get(`/api/ext/${ID}/ping`)).status === 200);

      await install('v2');
      expect((await st.manager.initializeServer(ID)).ok).toBe(true);
      const v2 = await get(`/api/ext/${ID}/ping`);
      expect(v2.body.version).toBe('v2');
      await post(`/api/ext/${ID}/crash`);
      await until(() => !alive(v2.body.pid as number));
      await until(() => unexpectedStops() === 3);
      // The third stop overall, but the first of the new code: a restart, not a give-up.
      const third = st.shownAtBroadcast
        .filter((c) => c.restartingAt !== null || c.serverError)
        .at(-1);
      expect(third?.serverError).toBeUndefined();
      expect(third?.restartingAt).toEqual(expect.any(String));
      await until(async () => (await get(`/api/ext/${ID}/ping`)).status === 200);
      expect(card().serverError).toBeUndefined();
    },
    TEST_MS
  );

  // Purpose: a stop someone asked for (here: turning it off after it gave
  // up) clears the crash history, so the card never keeps an old "stopped 3
  // times" and the next start is fresh.
  it(
    'forgets the crash history when it is turned off',
    async () => {
      await install();
      await boot(1);
      const pid = (await get(`/api/ext/${ID}/ping`)).body.pid as number;
      await post(`/api/ext/${ID}/crash`);
      await until(() => !alive(pid));
      await until(() => card().serverError?.code === 'server_crashed');
      await st.manager.disable(ID);
      expect(card().serverError).toBeUndefined();
      await st.manager.enable(ID);
      expect((await get(`/api/ext/${ID}/ping`)).status).toBe(200);
    },
    TEST_MS
  );

  // Purpose: a stuck event loop is stopped by the watchdog and reported as
  // unresponsive (budget 1 here, so the first stop is the last).
  it(
    'stops a hung extension as unresponsive',
    async () => {
      await install();
      await boot(1, { pingIntervalMs: 200, pongTimeoutMs: 1_500 });
      const pid = (await get(`/api/ext/${ID}/ping`)).body.pid as number;
      const since = Date.now();
      await post(`/api/ext/${ID}/hang`);
      await until(() => card().serverError?.code === 'server_unresponsive');
      expect(card().serverError?.message).toBe(`${NAME} stopped responding, so DorkOS stopped it.`);
      // Never quiet: a watchdog stop that ends the restarts says so (DOR-4785).
      await until(() => stoppedNotices().length === 1);
      expect(stoppedNotices()[0]).toMatchObject({
        title: `The ${NAME} app is off`,
        body: 'It stopped once in 10 minutes, so DorkOS left it off.',
      });
      expect(alive(pid)).toBe(false);
      const data = await extensionErrors();
      expect(data.count).toBe(1);
      expect(data.errors[0].serverError.code).toBe('server_unresponsive');
      expect(Date.parse(data.errors[0].serverError.occurredAt)).toBeGreaterThanOrEqual(since);
      expect(st.manager.listErrors()[0].serverError).toEqual(data.errors[0].serverError);
      expect((await get('/api/health')).status).toBe(200);
    },
    TEST_MS
  );

  // Purpose: turning it off ends its process, and nothing restarts it.
  it(
    'ends its process when it is turned off',
    async () => {
      await install();
      await boot();
      const pid = (await get(`/api/ext/${ID}/ping`)).body.pid as number;
      await st.manager.disable(ID);
      expect(alive(pid)).toBe(false);
      // An absence check: well past the harness's longest restart backoff (40 ms).
      await new Promise((r) => setTimeout(r, 200));
      expect(st.manager.getServerHandler(ID)).toBeNull();
      expect(sends.stopped).toContain(ID);
    },
    TEST_MS
  );

  // Purpose: a copy follows its agent's level on every load, Security's Must on #3280.
  it(
    'a lowered agent’s edit does not run on a reload by id, with no scan since the lowering',
    async () => {
      agentLevel.mode = 'bypassPermissions';
      await install('v1');
      await boot();
      expect((await get(`/api/ext/${ID}/ping`)).body.version).toBe('v1');
      agentLevel.mode = 'default';
      await install('v2');
      // An edit no scan has seen asks for one in the background (DOR-4282);
      // the shared teardown waits for it before deleting the data folder.
      const refresh = vi.spyOn(st.manager, 'requestRefresh');
      await st.manager.reloadExtension(ID);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect((await get(`/api/ext/${ID}/ping`)).body.version).not.toBe('v2');
      agentLevel.mode = 'bypassPermissions';
    },
    TEST_MS
  );

  it(
    'lowered, scanned, edited, raised, scanned: the edit stays held, and a new edit runs',
    async () => {
      agentLevel.mode = 'bypassPermissions';
      await install('v1');
      await boot();
      agentLevel.mode = 'default';
      await st.manager.reload();
      await install('v2');
      agentLevel.mode = 'bypassPermissions';
      await st.manager.reload();
      expect((await get(`/api/ext/${ID}/ping`)).body.version).not.toBe('v2');

      await install('v3');
      await st.manager.reload();
      expect((await get(`/api/ext/${ID}/ping`)).body.version).toBe('v3');
    },
    TEST_MS
  );

  // Purpose: at Full, an edit no file tool noted (a shell, another program) never runs on its
  // own, on either load path: a reload by id, which skips the scan, or a full scan (DOR-4528).
  it(
    'does not run an edit nothing noted, on a reload or a scan',
    async () => {
      await install('v1');
      await boot();
      expect((await get(`/api/ext/${ID}/ping`)).body.version).toBe('v1');
      await fs.writeFile(path.join(st.extDir, 'server.ts'), serverSource('v2'));
      await st.manager.reloadExtension(ID);
      expect((await get(`/api/ext/${ID}/ping`)).body.version).not.toBe('v2');
      await st.manager.reload();
      expect((await get(`/api/ext/${ID}/ping`)).body.version).not.toBe('v2');
    },
    TEST_MS
  );

  // Purpose: what runs is what was judged. Files that change after the scan read them are judged
  // again, from the snapshot about to run, before anything builds (DOR-4528).
  it(
    'judges the files about to run, even when they changed after the scan read them',
    async () => {
      await install('v1');
      await boot();
      const record = st.manager.get(ID)!;
      await fs.writeFile(path.join(st.extDir, 'server.ts'), serverSource('v2'));
      await placeSnapshots(st.dorkHome, [record], stored.value);
      expect(record.originProblem).toBe('changed');
      expect(record.runPath).toBeUndefined();
    },
    TEST_MS
  );

  // Purpose: the dev loop. A new server.ts is served by a new process after
  // a reload (what a dev link's save calls); a manifest that asks for a new
  // host waits for a person, and one that asks for less runs without asking.
  it(
    'serves new code after a reload, and waits for a person when it asks for more',
    async () => {
      await install('v1');
      await boot();
      const first = (await get(`/api/ext/${ID}/ping`)).body.pid as number;

      await install('v2');
      await st.manager.reloadExtension(ID);
      const v2 = await get(`/api/ext/${ID}/ping`);
      expect(v2.body.version).toBe('v2');
      expect(v2.body.pid).not.toBe(first);
      expect(alive(first)).toBe(false);

      await install('v2', ['api.example.com']);
      await st.manager.reload();
      expect(st.manager.getServerHandler(ID)).toBeNull();
      expect(card().approvedToRun).toBe(false);
      expect(alive(v2.body.pid as number)).toBe(false);

      await install('v2', []);
      await st.manager.reload();
      expect(card().approvedToRun).toBe(true);
      expect((await get(`/api/ext/${ID}/ping`)).status).toBe(200);
    },
    TEST_MS
  );
});
