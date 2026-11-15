/**
 * @vitest-environment node
 *
 * A project's own OpenCode plugin, on the pinned real binary (DOR-4394).
 *
 * The plugin writes a marker file from its module's top level, so the marker
 * exists exactly when OpenCode imported it. Three cases:
 *
 * 1. Control: `opencode run` in the project, with DorkOS's own sidecar
 *    environment (`OPENCODE_DISABLE_PROJECT_CONFIG` included), writes the
 *    marker. That is the hole: the second loader ignores the switch. If this
 *    stops writing the marker, the cases below prove nothing, so it fails.
 * 2. DorkOS's real runtime and real sidecar, sent a real prompt in that
 *    project: the turn is refused, the model is never asked, and the marker
 *    stays unwritten.
 * 3. The same runtime in a clean project reaches the model, so case 2's
 *    silence is the gate and not a broken sidecar.
 *
 * Nothing here can spend or reach the internet: a fake model on 127.0.0.1,
 * every other address sent to a proxy that does not answer, HOME and every
 * XDG folder throwaway, the model catalog fetch and self-update off.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { buildSidecarSpawnEnv } from '../server-manager.js';
import { OPENCODE_OWN_PLAN } from '../credits-sidecar.js';
import { PROJECT_PLUGINS_CODE } from '../messaging/project-plugin-guard.js';
import { OFFLINE_PROXY_ENV, pinnedOpenCode } from './pinned-opencode.js';

const BINARY = pinnedOpenCode();

/** One streamed chat-completions chunk. */
function chunk(delta: object, finish: string | null = null): string {
  const body = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'x' };
  return `data: ${JSON.stringify({ ...body, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

/** A fake model that answers every request with one word, and counts them. */
function fakeModel(calls: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (part) => (raw += part));
      req.on('end', () => {
        calls.push(raw);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(chunk({ role: 'assistant', content: 'done' }));
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
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

/** A project folder with a `.git`, and a plugin that writes `marker` when imported. */
function projectWithMarkerPlugin(root: string, marker: string): string {
  const project = path.join(root, 'acme-project');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.join(project, '.opencode', 'plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.opencode', 'plugin', 'marker.js'),
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(marker)}, 'imported');\n` +
      `export const Marker = async () => ({});\n`
  );
  return project;
}

/** Run `opencode run` in `cwd` until it exits; 60 s at most. */
async function runOnce(cwd: string, env: Record<string, string>): Promise<string> {
  const child = spawn(BINARY!, ['run', '-m', 'fake/x', 'hello'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => (output += String(data)));
  child.stderr.on('data', (data) => (output += String(data)));
  await new Promise<void>((resolve) => {
    // Let the run finish: the plugin is imported after the first model call.
    const deadline = setTimeout(resolve, 60_000);
    child.once('exit', () => {
      clearTimeout(deadline);
      resolve();
    });
  });
  child.kill('SIGKILL');
  return output;
}

describe.skipIf(BINARY === null)('a project plugin on the real OpenCode (DOR-4394)', () => {
  let root: string;
  let calls: string[];
  let model: Awaited<ReturnType<typeof fakeModel>>;
  let manager: { shutdown: () => Promise<void> } | undefined;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-plugin-guard-live-')));
    calls = [];
    model = await fakeModel(calls);
    for (const dir of ['home', 'config/opencode', 'data', 'cache', 'state', 'dork']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    // The fake model lives in the throwaway GLOBAL config, which the sidecar
    // still reads; the person's own config is where their own plugins load.
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
  }, 120_000);

  afterAll(async () => {
    await manager?.shutdown();
    vi.unstubAllEnvs();
    await model.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('control: the switch alone does not stop the plugin, so the marker is a real signal', async () => {
    const marker = path.join(root, 'control-marker');
    const project = projectWithMarkerPlugin(path.join(root, 'control'), marker);
    const env = {
      ...buildSidecarSpawnEnv(OPENCODE_OWN_PLAN, 'pw', {}),
      ...OFFLINE_PROXY_ENV,
    } as Record<string, string>;
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    const output = await runOnce(project, env);
    expect(fs.existsSync(marker), output).toBe(true);
  }, 90_000);

  it("DorkOS refuses a real prompt there, and the plugin's code never runs", async () => {
    const marker = path.join(root, 'guarded-marker');
    const project = projectWithMarkerPlugin(path.join(root, 'guarded'), marker);
    const { OpenCodeServerManager } = await import('../server-manager.js');
    const { OpenCodeRuntime } = await import('../opencode-runtime.js');
    const live = new OpenCodeServerManager();
    manager = live;
    const runtime = new OpenCodeRuntime({ provider: live });
    runtime.ensureSession('guarded', { permissionMode: 'default', cwd: project });
    const before = calls.length;

    const events: StreamEvent[] = [];
    for await (const event of runtime.sendMessage('guarded', 'hello', { cwd: project })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ code: PROJECT_PLUGINS_CODE }),
      }),
    ]);
    expect(calls.length).toBe(before);
    expect(fs.existsSync(marker)).toBe(false);

    // The same runtime and sidecar reach the model from a clean project, so
    // the silence above is the gate and not a broken sidecar.
    const clean = path.join(root, 'clean-project');
    fs.mkdirSync(path.join(clean, '.git'), { recursive: true });
    runtime.ensureSession('clean', { permissionMode: 'default', cwd: clean });
    for await (const _event of runtime.sendMessage('clean', 'hello', { cwd: clean })) {
      // Drained.
    }
    expect(calls.length).toBeGreaterThan(before);
    expect(fs.existsSync(marker)).toBe(false);
  }, 150_000);

  it('the calls DorkOS makes outside a turn do not import it either (Security Should 1)', async () => {
    const marker = path.join(root, 'side-marker');
    const project = projectWithMarkerPlugin(path.join(root, 'side'), marker);
    const { OpenCodeServerManager } = await import('../server-manager.js');
    const live =
      (manager as InstanceType<typeof OpenCodeServerManager> | undefined) ??
      new OpenCodeServerManager();
    manager = live;
    const client = await live.getClient(project);
    const query = { query: { directory: project } };
    // The four calls DorkOS sends with a project folder outside a turn: a new
    // session's bind, MCP status, the config read beside it, and the model list.
    await client.session.create({ ...query, body: {} });
    await client.mcp.status(query);
    await client.config.get(query);
    await client.provider.list(query);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(fs.existsSync(marker)).toBe(false);
  }, 120_000);
});
