/**
 * Every OpenCode turn is checked for a project's own plugins before the
 * sidecar sees the folder (DOR-4394): on each turn, not once per chat, and on
 * every path that can start one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StreamEvent } from '@dorkos/shared/types';
import { OpenCodeRuntime } from '../opencode-runtime.js';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';
import { PROJECT_PLUGINS_CODE } from '../messaging/project-plugin-guard.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-plugin-turns-')));
  roots.push(root);
  mkdirSync(join(root, '.git'));
  return root;
}

/** A provider whose sidecar stops every turn right after setup: only the gate is under test. */
function stubProvider() {
  const prepareTurn = vi.fn(async () => ({
    mode: 'own' as const,
    fingerprint: 'own',
    launch: null,
    models: [],
  }));
  const getClient = vi.fn(async () => {
    throw new Error('stop here: the turn got past the gate');
  });
  const provider: OpenCodeClientProvider = {
    getClient,
    peekClient: () => null,
    prepareTurn,
    setBusyProbe: vi.fn(),
    turnSettled: vi.fn(async () => {}),
  };
  return { provider, prepareTurn, getClient };
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[] | 'reached'> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
  } catch (err) {
    if (String(err).includes('got past the gate')) return 'reached';
    throw err;
  }
  return events;
}

describe('a project with its own OpenCode plugins', () => {
  it('lets turn 1 through, then refuses turn 2 once a plugin appears', async () => {
    const dir = repo();
    const { provider, prepareTurn, getClient } = stubProvider();
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('s1', { permissionMode: 'default', cwd: dir });

    expect(await drain(runtime.sendMessage('s1', 'hello', { cwd: dir }))).toBe('reached');
    const prepared = prepareTurn.mock.calls.length;
    const clients = getClient.mock.calls.length;

    mkdirSync(join(dir, '.opencode', 'plugin'), { recursive: true });
    writeFileSync(join(dir, '.opencode', 'plugin', 'p.ts'), 'export default {}\n');

    const events = await drain(runtime.sendMessage('s1', 'again', { cwd: dir }));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ code: PROJECT_PLUGINS_CODE }),
      }),
    ]);
    // Refused before the sidecar was prepared or asked about the folder.
    expect(prepareTurn.mock.calls.length).toBe(prepared);
    expect(getClient.mock.calls.length).toBe(clients);
    expect(runtime.hasRunningTurns()).toBe(false);
  });

  it('refuses a compaction too', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ plugin: ['some-npm-plugin'] }));
    const { provider, prepareTurn } = stubProvider();
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('s2', { permissionMode: 'default', cwd: dir });

    const events = await drain(runtime.executeCommandIntent('s2', 'compact', { cwd: dir }));
    expect(events).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ code: PROJECT_PLUGINS_CODE }) }),
    ]);
    expect(prepareTurn).not.toHaveBeenCalled();
  });
});

// Census: the gate holds only if every way a turn reaches the sidecar passes
// through it. Read off the source, so a new start path that skips the shared
// turn function fails here.
describe('census: every turn start passes the plugin gate', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, '..', 'opencode-runtime.ts'), 'utf8');

  it('checks first thing in the shared turn function, before the sidecar or the session', () => {
    const start = source.indexOf('private async *runOpenCodeTurn(');
    const gate = source
      .slice(start)
      .search(
        /const pluginRefusal = projectPluginRefusal\(cwd\);\s*if \(pluginRefusal\) return yield pluginRefusal;/
      );
    expect(start).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    for (const later of ['this.prepareSidecar(', 'this.resolveOpenCodeSession(', 'getClient(']) {
      expect(source.indexOf(later, start) - start).toBeGreaterThan(gate);
    }
  });

  it('sends a prompt or a summary only from inside a turn the gate checked', () => {
    const turnCalls = [...source.matchAll(/yield\* this\.runOpenCodeTurn\(/g)].map((m) => m.index!);
    const sends = [
      ...source.matchAll(/client\.session\.(promptAsync|summarize|command|prompt|shell)\(/g),
    ];
    expect(sends.length).toBeGreaterThan(0);
    for (const send of sends) {
      // Each send sits in the callback of the nearest runOpenCodeTurn call above it.
      const opener = turnCalls.filter((at) => at < send.index!).at(-1);
      expect(opener, send[0]).toBeDefined();
      const between = source.slice(opener!, send.index!);
      expect(between, send[0]).not.toMatch(/\n {2}(async \*|private |public |get )\w/);
    }
  });

  it('starts every public turn through the shared turn function', () => {
    for (const entry of ['async *sendMessage(', 'async *executeCommandIntent(']) {
      const at = source.indexOf(entry);
      const next = source.indexOf('\n  async ', at + entry.length);
      expect(source.slice(at, next === -1 ? undefined : next)).toContain(
        'yield* this.runOpenCodeTurn('
      );
    }
    // No other public generator exists that could start a turn some other way.
    const generators = [...source.matchAll(/\n {2}async \*(\w+)\(/g)].map((m) => m[1]);
    expect(generators.sort()).toEqual(['executeCommandIntent', 'sendMessage']);
  });
});
