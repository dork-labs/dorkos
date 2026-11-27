/**
 * @vitest-environment node
 *
 * A project plugin that appears during an OpenCode turn, on the pinned real
 * binary (DOR-4412, DOR-5258).
 *
 * The plugin writes a marker (its process id) from its module's top level and
 * keeps a heartbeat file fresh every 100 ms, so the marker says OpenCode
 * imported it and the heartbeat says that process is still running its code.
 * DorkOS's real runtime and real sidecar, a fake model on 127.0.0.1:
 *
 * 1. The plugin lands as the turn's prompt is sent, and the fake model waits
 *    until it has loaded, so its code is running during the turn. Once the
 *    turn ends, the process running it must be gone before the next chat's
 *    prompt reaches the model, and its heartbeat must stop.
 * 2. The plugin lands while the model is answering, as a `git clone` in the
 *    turn would. The sidecar is restarted, the folder's next turn is refused,
 *    and the marker stays unwritten.
 * 3. The plugin is in place by the turn's first event, and the model is slow.
 *    The sidecar is restarted at that event: the plugin's process and its
 *    child are gone about a second later, long before the model would reply.
 *
 * Native calls cannot spend or reach the internet: a fake model on 127.0.0.1,
 * every other address sent to a proxy that does not answer, HOME and every
 * XDG folder throwaway, the model catalog fetch and self-update off.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import * as childProcess from 'node:child_process';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { PROJECT_PLUGINS_CODE } from '../messaging/project-plugin-guard.js';
import {
  PLUGIN_RESTART_MESSAGE,
  setPluginRestartActivity,
  type PluginRestartActivityEntry,
} from '../messaging/project-plugin-recheck.js';
import { preparePluginDependencies } from './project-plugin-settlement/prepare-plugin-dependencies.js';
import { OFFLINE_PROXY_ENV, pinnedOpenCode, guardedOpenCodeSpawn } from './pinned-opencode.js';

// Keep the real OS process, while pinning every launch of the binary.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const BINARY = pinnedOpenCode();

/** One streamed chat-completions chunk. */
function chunk(delta: object, finish: string | null = null): string {
  const body = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'x' };
  return `data: ${JSON.stringify({ ...body, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

/**
 * Runs on each model request before it is answered; the answer waits for it.
 * Row 1 waits for the import, row 2 drops the plugin.
 */
let beforeReply: ((raw: string) => Promise<void>) | undefined;

/** A fake model that answers every request with one word, and keeps each body. */
function fakeModel(calls: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (part) => (raw += part));
      req.on('end', () => {
        calls.push(raw);
        void (beforeReply?.(raw) ?? Promise.resolve()).finally(() => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(chunk({ role: 'assistant', content: 'done' }));
          res.write(chunk({}, 'stop'));
          res.end('data: [DONE]\n\n');
        });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** A clean made-up project folder with a `.git`. */
function project(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

/**
 * Drop a plugin into `dir` that writes `marker` on import and beats into `beat`.
 * It also ignores SIGTERM and starts a child of its own, whose pid it writes to
 * `<marker>.child`, so a restart must SIGKILL the whole process group.
 */
function dropPlugin(dir: string, marker: string, beat: string): void {
  fs.mkdirSync(path.join(dir, '.opencode', 'plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.opencode', 'plugin', 'x.js'),
    `import { writeFileSync } from 'node:fs';\n` +
      `import { spawn } from 'node:child_process';\n` +
      `process.on('SIGTERM', () => {});\n` +
      `const kid = spawn('sleep', ['600'], { stdio: 'ignore' });\n` +
      `writeFileSync(${JSON.stringify(`${marker}.child`)}, String(kid.pid));\n` +
      // The first beat before the marker: a restart can SIGKILL the process
      // before an interval fires, and the test reads the beat once the marker shows.
      `const beat = () => writeFileSync(${JSON.stringify(beat)}, String(Date.now()));\n` +
      `beat();\n` +
      `writeFileSync(${JSON.stringify(marker)}, String(process.pid));\n` +
      `setInterval(beat, 100);\n` +
      `export const Marker = async () => ({});\n`
  );
}

/** Wait until `check` holds, `ms` at most. */
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
  return true;
}

/** Whether a process id is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe.skipIf(BINARY === null)(
  'a plugin that appears during an OpenCode turn (DOR-4412, DOR-5258)',
  () => {
    let root: string;
    let calls: string[];
    let model: Awaited<ReturnType<typeof fakeModel>>;
    let manager: {
      shutdown: () => Promise<void>;
      getClient: (cwd: string) => Promise<OpencodeClient>;
    };
    let runtime: InstanceType<typeof import('../opencode-runtime.js').OpenCodeRuntime>;
    let dependencies: Awaited<ReturnType<typeof preparePluginDependencies>> | undefined;
    const lines: PluginRestartActivityEntry[] = [];
    const integrityChecks: Promise<void>[] = [];

    beforeAll(async () => {
      const realSpawn = vi.mocked(childProcess.spawn).getMockImplementation()!;
      vi.spyOn(childProcess, 'spawn').mockImplementation(((binary, args, options) => {
        if (binary !== BINARY) return realSpawn(binary, args ?? [], options ?? {});
        const result = guardedOpenCodeSpawn(realSpawn, binary, args ?? [], options ?? {});
        integrityChecks.push(result.verified);
        return result.child;
      }) as typeof childProcess.spawn);
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-plugin-recheck-live-')));
      calls = [];
      model = await fakeModel(calls);
      for (const dir of ['home', 'config/opencode', 'data', 'cache', 'state', 'dork']) {
        fs.mkdirSync(path.join(root, dir), { recursive: true });
      }
      dependencies = await preparePluginDependencies(
        path.join(root, 'config', 'opencode'),
        path.join(root, 'npm-preparation')
      );
      fs.writeFileSync(
        path.join(root, 'config', 'opencode', 'opencode.json'),
        JSON.stringify({
          enabled_providers: ['fake'],
          model: 'fake/x',
          small_model: 'fake/x',
          provider: {
            fake: {
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: `${model.url}/v1`, apiKey: 'fake-key-never-real' },
              models: { x: { name: 'x' } },
            },
          },
        })
      );
      vi.stubEnv('HOME', path.join(root, 'home'));
      vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'));
      vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
      vi.stubEnv('XDG_CACHE_HOME', path.join(root, 'cache'));
      vi.stubEnv('XDG_STATE_HOME', path.join(root, 'state'));
      vi.stubEnv('OPENCODE_DISABLE_MODELS_FETCH', '1');
      vi.stubEnv('OPENCODE_DISABLE_AUTOUPDATE', '1');
      for (const [name, value] of Object.entries(OFFLINE_PROXY_ENV)) vi.stubEnv(name, value);
      for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) {
        vi.stubEnv(name, undefined);
      }
      const dorkHome = path.join(root, 'dork');
      fs.writeFileSync(
        path.join(dorkHome, 'config.json'),
        JSON.stringify({
          runtimes: {
            default: 'opencode',
            opencode: {
              enabled: true,
              binaryPath: BINARY,
              port: 0,
              provider: null,
              baseURL: null,
              defaultModel: null,
              defaultTrustStop: null,
            },
          },
        })
      );
      (await import('../../../core/config-manager.js')).initConfigManager(dorkHome);
      const { OpenCodeServerManager } = await import('../server-manager.js');
      const { OpenCodeRuntime } = await import('../opencode-runtime.js');
      const live = new OpenCodeServerManager();
      manager = live;
      runtime = new OpenCodeRuntime({ provider: live });
      setPluginRestartActivity((entry) => lines.push(entry));
    }, 120_000);

    afterAll(async () => {
      try {
        try {
          await manager?.shutdown();
        } finally {
          await Promise.all(integrityChecks);
          await dependencies?.verifyUnchanged();
        }
      } finally {
        setPluginRestartActivity(undefined);
        beforeReply = undefined;
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await model?.close();
        if (root)
          fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    });

    it('ends the process that imported it before the next chat is sent', async () => {
      const race = project(root, 'northwind-race');
      const marker = path.join(root, 'race-marker');
      const beat = path.join(root, 'race-beat');
      // The plugin lands as the prompt is sent. Once, on this sidecar's client.
      const client = await manager.getClient(race);
      const send = client.session.promptAsync.bind(client.session);
      let armed = true;
      client.session.promptAsync = ((options: Parameters<typeof send>[0]) => {
        if (armed) dropPlugin(race, marker, beat);
        armed = false;
        return send(options);
      }) as typeof send;
      // The reply waits until the plugin has loaded.
      beforeReply = async () => {
        await until(() => fs.existsSync(marker), 75_000);
      };
      runtime.ensureSession('race', { permissionMode: 'default', cwd: race });
      await drain(runtime.sendMessage('race', 'hello', { cwd: race }));
      beforeReply = undefined;

      // The row's premise: the plugin's code ran during the turn.
      expect(fs.existsSync(marker)).toBe(true);
      const importer = Number(fs.readFileSync(marker, 'utf8'));
      const spawned = Number(fs.readFileSync(`${marker}.child`, 'utf8'));
      onTestFinished(() => {
        if (alive(spawned)) process.kill(spawned, 'SIGKILL');
      });

      // Another chat in a clean folder. When its prompt reaches the model, the
      // process that imported the plugin must already be gone.
      const clean = project(root, 'clean-after-race');
      runtime.ensureSession('after', { permissionMode: 'default', cwd: clean });
      let importerAliveAtNextTurn: boolean | undefined;
      beforeReply = async () => {
        importerAliveAtNextTurn ??= alive(importer);
      };
      const second = await drain(runtime.sendMessage('after', 'hello', { cwd: clean }));
      beforeReply = undefined;
      const beatAfter = fs.readFileSync(beat, 'utf8');
      await new Promise((done) => setTimeout(done, 1_000));
      expect({
        nextTurnRan: !second.some((event) => event.type === 'error'),
        importerAliveAtNextTurn,
        importerAliveNow: alive(importer),
        pluginChildAliveNow: alive(spawned),
        heartbeatStillRunning: fs.readFileSync(beat, 'utf8') !== beatAfter,
        activity: lines.map((line) => line.folder),
      }).toEqual({
        nextTurnRan: true,
        importerAliveAtNextTurn: false,
        importerAliveNow: false,
        pluginChildAliveNow: false,
        heartbeatStillRunning: false,
        activity: [race],
      });
    }, 240_000);

    it('restarts and refuses the folder when the plugin lands while the model answers', async () => {
      const cloned = project(root, 'northwind-clone');
      const marker = path.join(root, 'clone-marker');
      const beat = path.join(root, 'clone-beat');
      let dropped = false;
      beforeReply = async (raw) => {
        // The turn's own request: the one that offers tools.
        if (!dropped && raw.includes('clone the repo') && raw.includes('"tools"')) {
          dropped = true;
          dropPlugin(cloned, marker, beat);
        }
      };
      runtime.ensureSession('clone', { permissionMode: 'default', cwd: cloned });
      await drain(runtime.sendMessage('clone', 'clone the repo', { cwd: cloned }));
      beforeReply = undefined;
      expect(dropped).toBe(true);

      const again = await drain(runtime.sendMessage('clone', 'again', { cwd: cloned }));
      // Give a late import every chance before saying it never happened.
      await new Promise((done) => setTimeout(done, 5_000));
      expect({
        restartedFor: lines.map((line) => line.folder).at(-1),
        nextTurnRefused: again.map((event) => (event.data as { code?: string }).code),
        markerWritten: fs.existsSync(marker),
      }).toEqual({
        restartedFor: cloned,
        nextTurnRefused: [PROJECT_PLUGINS_CODE],
        markerWritten: false,
      });
    }, 240_000);
    it("restarts at the turn's first event, long before a slow model replies", async () => {
      const early = project(root, 'northwind-early');
      const marker = path.join(root, 'early-marker');
      const beat = path.join(root, 'early-beat');
      const REPLY_MS = 30_000;
      const client = await manager.getClient(early);
      const send = client.session.promptAsync.bind(client.session);
      let sentAt = 0;
      client.session.promptAsync = ((options: Parameters<typeof send>[0]) => {
        if (!sentAt) {
          dropPlugin(early, marker, beat);
          sentAt = Date.now();
        }
        return send(options);
      }) as typeof send;
      // The model takes REPLY_MS to answer, so the turn would run that long.
      let released = false;
      beforeReply = async () => {
        await until(() => released, REPLY_MS);
      };
      onTestFinished(() => {
        released = true;
        beforeReply = undefined;
      });
      // The first-event check writes the Activity line as it starts the restart.
      let restartedAt = 0;
      setPluginRestartActivity((entry) => {
        lines.push(entry);
        restartedAt ||= Date.now();
      });
      runtime.ensureSession('early', { permissionMode: 'default', cwd: early });
      const events = await drain(runtime.sendMessage('early', 'hello', { cwd: early }));
      const endedAt = Date.now();
      // Every process the plugin had, by the pids it wrote, a second later.
      await new Promise((done) => setTimeout(done, 1_000));
      const pid = (file: string) =>
        fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
      const importer = pid(marker);
      const spawned = pid(`${marker}.child`);
      onTestFinished(() => {
        if (spawned && alive(spawned)) process.kill(spawned, 'SIGKILL');
      });
      const lastBeat = pid(beat);
      console.info('[DOR-5258 live]', {
        loaded: importer > 0,
        sentToRestartMs: restartedAt ? restartedAt - sentAt : null,
        restartToTurnEndMs: restartedAt ? endedAt - restartedAt : null,
        lastBeatAfterRestartMs: lastBeat && restartedAt ? lastBeat - restartedAt : null,
        turnMs: endedAt - sentAt,
      });
      expect({
        restartedFor: lines.map((line) => line.folder).at(-1),
        errors: events
          .filter((event) => event.type === 'error')
          .map((event) => (event.data as { message: string }).message),
        endedBeforeTheReply: endedAt - sentAt < REPLY_MS / 3,
        importerAlive: importer > 0 && alive(importer),
        pluginChildAlive: spawned > 0 && alive(spawned),
        // Its code ran for at most about a second after the first event.
        beatsWithinASecond: !lastBeat || lastBeat - restartedAt < 1_500,
      }).toEqual({
        restartedFor: early,
        errors: [PLUGIN_RESTART_MESSAGE],
        endedBeforeTheReply: true,
        importerAlive: false,
        pluginChildAlive: false,
        beatsWithinASecond: true,
      });
    }, 240_000);
  }
);
