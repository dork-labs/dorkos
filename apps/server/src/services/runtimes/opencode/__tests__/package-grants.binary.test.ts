/**
 * @vitest-environment node
 *
 * A globally installed package's own folder, on the pinned real binary
 * (DOR-4386).
 *
 * DorkOS's real runtime and real sidecar run four turns nobody is watching,
 * each driven by a fake model that asks for one tool call:
 *
 * 1. It reads the package's own skill: OpenCode raises `external_directory`,
 *    DorkOS answers it with no card, and the file's words reach the model.
 * 2. It writes over that skill: refused with no card, and the file is unchanged.
 * 3. A shell `touch` inside the package, in Default mode: the read grant does
 *    not answer it, so the ask reaches the person (denied here), and no file
 *    appears (Security's Should on #3793).
 * 4. It reads a backup an install left beside the package: no grant, so the ask
 *    reaches the person (denied here), and the file's words never reach the model.
 *
 * Nothing here can spend or reach the internet: a fake model on 127.0.0.1,
 * every other address sent to a proxy that does not answer, HOME, DORK_HOME
 * and every XDG folder throwaway, the model catalog fetch and self-update off.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MARKETPLACE_BACKUP_DIR_MARKER } from '@dorkos/shared/marketplace-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { OFFLINE_PROXY_ENV, pinnedOpenCode } from './pinned-opencode.js';

const BINARY = pinnedOpenCode();

/** Words that exist only inside the two skill files, so a request carrying them read the file. */
const PACKAGE_WORDS = 'zebra-lantern-4386';
const BACKUP_WORDS = 'otter-compass-4386';

/** One streamed chat-completions chunk. */
function chunk(delta: object, finish: string | null = null): string {
  const body = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'x' };
  return `data: ${JSON.stringify({ ...body, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

/** The tool call the fake model makes on the next turn, once. */
let nextTool: { name: string; args: Record<string, string> } | undefined;

/**
 * A fake model. A request with tools that ends on the person's message gets the
 * planned tool call; anything else (the tool's result, a title) gets one word.
 * Every request body is kept, so a test can see what reached the model.
 */
function fakeModel(bodies: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (part) => (raw += part));
      req.on('end', () => {
        bodies.push(raw);
        const request = JSON.parse(raw) as {
          tools?: unknown[];
          messages?: Array<{ role: string }>;
        };
        const last = request.messages?.at(-1)?.role;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (request.tools?.length && last === 'user' && nextTool) {
          const { name, args } = nextTool;
          nextTool = undefined;
          res.write(
            chunk({
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${name}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            })
          );
          res.write(chunk({}, 'tool_calls'));
        } else {
          res.write(chunk({ role: 'assistant', content: 'done' }));
          res.write(chunk({}, 'stop'));
        }
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

/** A global package folder with a manifest and one skill holding `words`. */
function writePackage(dir: string, words: string): string {
  fs.mkdirSync(path.join(dir, '.dork'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.dork', 'manifest.json'),
    JSON.stringify({ name: path.basename(dir), version: '1.0.0', type: 'plugin', description: 'x' })
  );
  const skill = path.join(dir, 'skills', 'ship', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, `---\nname: ship\ndescription: ship\n---\n${words}\n`);
  return skill;
}

describe.skipIf(BINARY === null)('a global package on the real OpenCode (DOR-4386)', () => {
  let root: string;
  let project: string;
  let packageSkill: string;
  let backupSkill: string;
  let bodies: string[];
  let model: Awaited<ReturnType<typeof fakeModel>>;
  let manager: { shutdown: () => Promise<void> } | undefined;
  let runtime: InstanceType<typeof import('../opencode-runtime.js').OpenCodeRuntime>;

  /** Run one turn to its end, denying any card it raises, and return its events. */
  async function turn(sessionId: string): Promise<StreamEvent[]> {
    runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: project });
    const events: StreamEvent[] = [];
    for await (const event of runtime.sendMessage(sessionId, 'go', { cwd: project })) {
      events.push(event);
      if (event.type === 'approval_required') {
        runtime.approveTool(sessionId, (event.data as { toolCallId: string }).toolCallId, false);
      }
    }
    return events;
  }

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-package-grants-live-')));
    bodies = [];
    model = await fakeModel(bodies);
    for (const dir of ['home', 'config/opencode', 'data', 'cache', 'state', 'dork']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
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
            models: { x: { name: 'x', tool_call: true } },
          },
        },
      })
    );
    const dorkHome = path.join(root, 'dork');
    const plugins = path.join(dorkHome, 'plugins');
    packageSkill = writePackage(path.join(plugins, 'acme'), PACKAGE_WORDS);
    backupSkill = writePackage(
      path.join(plugins, `acme${MARKETPLACE_BACKUP_DIR_MARKER}1`),
      BACKUP_WORDS
    );
    project = path.join(root, 'acme-project');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });

    vi.stubEnv('DORK_HOME', dorkHome);
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
  }, 120_000);

  afterAll(async () => {
    await manager?.shutdown();
    vi.unstubAllEnvs();
    await model.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("reads the package's own skill with no card, and its words reach the model", async () => {
    nextTool = { name: 'read', args: { filePath: packageSkill } };
    const before = bodies.length;

    const events = await turn('read-package');

    expect(nextTool).toBeUndefined();
    expect(events.filter((event) => event.type === 'approval_required')).toEqual([]);
    expect(bodies.slice(before).some((body) => body.includes(PACKAGE_WORDS))).toBe(true);
  }, 150_000);

  it('refuses a write over that skill with no card, and the file is unchanged', async () => {
    const original = fs.readFileSync(packageSkill, 'utf8');
    nextTool = { name: 'write', args: { filePath: packageSkill, content: 'overwritten' } };

    const events = await turn('write-package');

    expect(nextTool).toBeUndefined();
    expect(events.filter((event) => event.type === 'approval_required')).toEqual([]);
    expect(fs.readFileSync(packageSkill, 'utf8')).toBe(original);
  }, 150_000);

  it('asks the person before a shell command writes inside the package, in Default mode', async () => {
    // The read grant answers OpenCode's `external_directory` ask for the
    // package folder, but it never answers a shell command: `bash` still
    // reaches the person, and nothing is written while they have not said yes.
    const created = path.join(path.dirname(packageSkill), 'touched-by-shell');
    nextTool = { name: 'bash', args: { command: `touch ${created}`, description: 'touch' } };

    const events = await turn('touch-package');

    expect(nextTool).toBeUndefined();
    const asks = events.filter((event) => event.type === 'approval_required');
    expect(asks.map((event) => (event.data as { toolName: string }).toolName)).toContain('bash');
    expect(fs.existsSync(created)).toBe(false);
  }, 150_000);

  it('grants no read of a backup beside the package: the ask reaches the person', async () => {
    nextTool = { name: 'read', args: { filePath: backupSkill } };
    const before = bodies.length;

    const events = await turn('read-backup');

    expect(nextTool).toBeUndefined();
    expect(events.filter((event) => event.type === 'approval_required')).toHaveLength(1);
    expect(bodies.slice(before).some((body) => body.includes(BACKUP_WORDS))).toBe(false);
  }, 150_000);
});
