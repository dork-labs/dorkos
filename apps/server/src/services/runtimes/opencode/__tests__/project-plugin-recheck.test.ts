/**
 * When an OpenCode turn's first event arrives, and again after the turn,
 * DorkOS looks again for a project's own plugins in the folders the turn used,
 * and restarts the shared sidecar when one has appeared, before any other turn
 * is sent (DOR-4412, DOR-5258). Real folders, the real runtime, a scripted
 * sidecar client; only the provider's restart is a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GlobalEvent, OpencodeClient } from '@opencode-ai/sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { OpenCodeRuntime } from '../opencode-runtime.js';
import { TurnEventQueue } from '../events/global-event-hub.js';
import type { OpenCodeWireEvent } from '../events/event-mapper.js';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';
import {
  PLUGIN_RESTART_FAILED_MESSAGE,
  PLUGIN_RESTART_MESSAGE,
  setPluginRestartActivity,
  type PluginRestartActivityEntry,
} from '../messaging/project-plugin-recheck.js';
import { makeConformanceClient } from './conformance-client.js';
import {
  OC_SESSION_A,
  OC_SESSION_B,
  globalEvent,
  opencodeSimpleTurn,
  serverConnected,
  sessionInfo,
} from './opencode-sse-fixtures.js';

const roots: string[] = [];
let lines: PluginRestartActivityEntry[];

beforeEach(() => {
  lines = [];
  setPluginRestartActivity((entry) => lines.push(entry));
});

afterEach(() => {
  setPluginRestartActivity(undefined);
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

/** A made-up repo in a throwaway folder. */
function repo(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-plugin-recheck-')));
  roots.push(root);
  const dir = join(root, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

/** What a clone of a repo with its own plugin leaves in `dir`. */
function dropPlugin(dir: string): void {
  mkdirSync(join(dir, '.opencode', 'plugin'), { recursive: true });
  writeFileSync(join(dir, '.opencode', 'plugin', 'x.js'), 'export default {}\n');
}

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A restart that fails is awaited later; it must not count as unhandled now.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const STOP = 'stop here: the turn got past the gate';

/**
 * A provider whose sidecar runs one scripted turn per folder in `clients`; a
 * folder it has no client for stops right after the gate. `recycle` is the
 * restart under test.
 */
function harness(clients: Record<string, ReturnType<typeof makeConformanceClient>>) {
  const restart = { next: deferred() };
  const recycle = vi.fn(() => restart.next.promise);
  const prepareTurn = vi.fn(async () => ({
    mode: 'own' as const,
    fingerprint: 'own',
    launch: null,
    models: [],
  }));
  const getClient = vi.fn(async (cwd: string) => {
    const client = clients[cwd];
    if (!client) throw new Error(STOP);
    return client as unknown as OpencodeClient;
  });
  const provider: OpenCodeClientProvider = {
    getClient,
    peekClient: () => null,
    prepareTurn,
    setBusyProbe: vi.fn(),
    turnSettled: vi.fn(async () => {}),
    recycle,
  };
  return { provider, recycle, prepareTurn, getClient, restart };
}

/** A sidecar client for one folder's turn; `stored` is the folder OpenCode keeps. */
function clientFor(stored: string) {
  return makeConformanceClient(opencodeSimpleTurn(OC_SESSION_A, 'pong'), stored);
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[] | string> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return events;
}

/** Let every queued promise continuation run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('after an OpenCode turn, a folder that gained its own plugins', () => {
  it('restarts the sidecar, says so in Activity, and holds the next turn until it is done', async () => {
    const dir = repo('northwind-widgets');
    const other = repo('clean-elsewhere');
    const client = clientFor(dir);
    // The turn clones a repo with its own plugin into its folder.
    client.session.promptAsync.mockImplementation(async () => {
      dropPlugin(dir);
      return {};
    });
    const { provider, recycle, prepareTurn, restart } = harness({ [dir]: client });
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('a', { permissionMode: 'default', cwd: dir });

    const first = await drain(runtime.sendMessage('a', 'clone it', { cwd: dir }));
    expect(first).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'done' })]));
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      {
        folder: dir,
        folders: [dir],
        summary: 'OpenCode restarted because northwind-widgets gained its own plugins.',
      },
    ]);

    // Another chat, another clean folder: it waits for the restart.
    const prepared = prepareTurn.mock.calls.length;
    runtime.ensureSession('b', { permissionMode: 'default', cwd: other });
    const second = drain(runtime.sendMessage('b', 'hello', { cwd: other }));
    await settle();
    expect(prepareTurn.mock.calls.length).toBe(prepared);
    restart.next.resolve();
    expect(await second).toBe(STOP);
    expect(prepareTurn.mock.calls.length).toBe(prepared + 1);
    expect(recycle).toHaveBeenCalledTimes(1);
  });

  it("restarts when only the session's stored folder gained them", async () => {
    const cwd = repo('chat-folder');
    const stored = repo('stored-folder');
    const client = clientFor(stored);
    client.session.create.mockResolvedValue({ data: sessionInfo(OC_SESSION_A, stored) });
    client.session.get.mockResolvedValue({ data: sessionInfo(OC_SESSION_A, stored) });
    client.session.promptAsync.mockImplementation(async () => {
      dropPlugin(stored);
      return {};
    });
    const { provider, recycle, restart } = harness({ [cwd]: client });
    restart.next.resolve();
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('s', { permissionMode: 'default', cwd });

    await drain(runtime.sendMessage('s', 'pull it', { cwd }));
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(lines.map((line) => line.folder)).toEqual([stored]);
  });

  it('does nothing when no folder gained plugins', async () => {
    const dir = repo('plain-repo');
    const { provider, recycle, prepareTurn } = harness({ [dir]: clientFor(dir) });
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('a', { permissionMode: 'default', cwd: dir });

    await drain(runtime.sendMessage('a', 'hello', { cwd: dir }));
    await drain(runtime.sendMessage('a', 'again', { cwd: dir }));
    expect(prepareTurn).toHaveBeenCalledTimes(2);
    expect(recycle).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('fails closed on a plugin folder it cannot read, as the pre-turn guard does', async () => {
    const dir = repo('locked-repo');
    const client = clientFor(dir);
    client.session.promptAsync.mockImplementation(async () => {
      mkdirSync(join(dir, '.opencode', 'plugin'), { recursive: true });
      chmodSync(join(dir, '.opencode', 'plugin'), 0o000);
      return {};
    });
    const { provider, recycle, restart } = harness({ [dir]: client });
    restart.next.resolve();
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('a', { permissionMode: 'default', cwd: dir });

    await drain(runtime.sendMessage('a', 'hello', { cwd: dir }));
    chmodSync(join(dir, '.opencode', 'plugin'), 0o700);
    expect(recycle).toHaveBeenCalledTimes(1);
  });

  it('stops a turn that was setting up on the old sidecar before it sends', async () => {
    const dir = repo('northwind-widgets');
    const other = repo('busy-elsewhere');
    const first = clientFor(dir);
    first.session.promptAsync.mockImplementation(async () => {
      dropPlugin(dir);
      return {};
    });
    const second = clientFor(other);
    // Its own OpenCode session, so its stored folder is its own.
    second.session.create.mockResolvedValue({ data: sessionInfo(OC_SESSION_B, other) });
    second.session.get.mockResolvedValue({ data: sessionInfo(OC_SESSION_B, other) });
    const held = deferred();
    const { provider, recycle, getClient, restart } = harness({ [dir]: first });
    restart.next.resolve();
    // The other chat's turn is past the gate, waiting on the old sidecar.
    getClient.mockImplementation(async (cwd: string) => {
      if (cwd === other) {
        await held.promise;
        return second as unknown as OpencodeClient;
      }
      return first as unknown as OpencodeClient;
    });
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('a', { permissionMode: 'default', cwd: dir });
    runtime.ensureSession('b', { permissionMode: 'default', cwd: other });
    await settle();

    const waiting = drain(runtime.sendMessage('b', 'hello', { cwd: other }));
    await settle();
    await drain(runtime.sendMessage('a', 'clone it', { cwd: dir }));
    expect(recycle).toHaveBeenCalledTimes(1);
    held.resolve();

    expect(await waiting).toBe(PLUGIN_RESTART_MESSAGE);
    expect(second.session.promptAsync).not.toHaveBeenCalled();
  });

  it('holds every turn while the restart fails, and tries it again first', async () => {
    const dir = repo('northwind-widgets');
    const other = repo('clean-elsewhere');
    const client = clientFor(dir);
    client.session.promptAsync.mockImplementation(async () => {
      dropPlugin(dir);
      return {};
    });
    const { provider, recycle, prepareTurn, restart } = harness({ [dir]: client });
    restart.next.reject(new Error('cleanup could not be confirmed'));
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('a', { permissionMode: 'default', cwd: dir });
    await drain(runtime.sendMessage('a', 'clone it', { cwd: dir }));
    const prepared = prepareTurn.mock.calls.length;

    runtime.ensureSession('b', { permissionMode: 'default', cwd: other });
    expect(await drain(runtime.sendMessage('b', 'hello', { cwd: other }))).toBe(
      PLUGIN_RESTART_FAILED_MESSAGE
    );
    expect(recycle).toHaveBeenCalledTimes(2);
    expect(prepareTurn.mock.calls.length).toBe(prepared);

    restart.next = deferred();
    restart.next.resolve();
    expect(await drain(runtime.sendMessage('b', 'hello', { cwd: other }))).toBe(STOP);
    expect(recycle).toHaveBeenCalledTimes(3);
  });
});

/**
 * A sidecar client whose turn events arrive only once the prompt is sent, as
 * a real sidecar's do. `onEvent` runs before each event goes out.
 */
function sendingClient(
  dir: string,
  onEvent: (index: number) => void = () => {},
  setupEvent?: OpenCodeWireEvent
) {
  const client = makeConformanceClient([], dir);
  let stream = new TurnEventQueue<GlobalEvent>();
  client.global.event.mockImplementation(async (options?: { signal?: AbortSignal }) => {
    stream = new TurnEventQueue<GlobalEvent>();
    options?.signal?.addEventListener('abort', () => stream.end(), { once: true });
    stream.push(globalEvent(dir, serverConnected()));
    return { stream };
  });
  // A setup call before the prompt (the asks check) that the sidecar answers
  // with an event of the turn's own session.
  const agents = client.app.agents.getMockImplementation();
  if (setupEvent)
    client.app.agents.mockImplementation(async () => {
      stream.push(globalEvent(dir, setupEvent));
      await settle();
      return agents ? agents() : { data: [] };
    });
  client.session.promptAsync.mockImplementation(async () => {
    const turn: OpenCodeWireEvent[] = opencodeSimpleTurn(OC_SESSION_A, 'pong');
    // One at a time, each delivered before the next is made.
    void (async () => {
      for (const [index, event] of turn.entries()) {
        onEvent(index);
        stream.push(globalEvent(dir, event));
        await settle();
      }
    })();
    return {};
  });
  return client;
}

/** What the person saw: the reply's text and any error's message. */
function seen(events: StreamEvent[] | string) {
  if (typeof events === 'string') return { thrown: events };
  return {
    text: events
      .filter((event) => event.type === 'text_delta')
      .map((event) => (event.data as { text: string }).text)
      .join(''),
    errors: events
      .filter((event) => event.type === 'error')
      .map((event) => (event.data as { message: string }).message),
    done: events.at(-1)?.type === 'done',
  };
}

describe("when an OpenCode turn's first event arrives", () => {
  it('restarts at once for a folder that has plugins by then, and ends the turn', async () => {
    const dir = repo('northwind-widgets');
    const other = repo('clean-elsewhere');
    // The plugin is in place before the sidecar's first event for the turn.
    const client = sendingClient(dir, (index) => {
      if (index === 0) dropPlugin(dir);
    });
    const { provider, recycle, prepareTurn, restart } = harness({ [dir]: client });
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('a', { permissionMode: 'default', cwd: dir });

    const first = await drain(runtime.sendMessage('a', 'clone it', { cwd: dir }));
    expect(seen(first)).toEqual({ text: '', errors: [PLUGIN_RESTART_MESSAGE], done: true });
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      {
        folder: dir,
        folders: [dir],
        summary: 'OpenCode restarted because northwind-widgets gained its own plugins.',
      },
    ]);

    // Another chat waits for the restart.
    const prepared = prepareTurn.mock.calls.length;
    runtime.ensureSession('b', { permissionMode: 'default', cwd: other });
    const second = drain(runtime.sendMessage('b', 'hello', { cwd: other }));
    await settle();
    expect(prepareTurn.mock.calls.length).toBe(prepared);
    restart.next.resolve();
    expect(await second).toBe(STOP);
    expect(recycle).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no folder has plugins', async () => {
    const dir = repo('plain-repo');
    const { provider, recycle } = harness({ [dir]: sendingClient(dir) });
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('a', { permissionMode: 'default', cwd: dir });

    const events = await drain(runtime.sendMessage('a', 'hello', { cwd: dir }));
    expect(seen(events)).toEqual({ text: 'pong', errors: [], done: true });
    expect(recycle).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('fails closed on a plugin folder it cannot read', async () => {
    const dir = repo('locked-repo');
    const client = sendingClient(dir, (index) => {
      if (index > 0) return;
      mkdirSync(join(dir, '.opencode', 'plugin'), { recursive: true });
      chmodSync(join(dir, '.opencode', 'plugin'), 0o000);
    });
    const { provider, recycle, restart } = harness({ [dir]: client });
    // Done before the turn ends, so the post-turn check could start another.
    restart.next.resolve();
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('a', { permissionMode: 'default', cwd: dir });

    const events = await drain(runtime.sendMessage('a', 'hello', { cwd: dir }));
    chmodSync(join(dir, '.opencode', 'plugin'), 0o700);
    expect(seen(events)).toEqual({ text: '', errors: [PLUGIN_RESTART_MESSAGE], done: true });
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(lines.map((line) => line.folder)).toEqual([dir]);
  });

  it('an event during setup does not use up the check; the first one after the send makes it', async () => {
    const dir = repo('northwind-widgets');
    const turn = opencodeSimpleTurn(OC_SESSION_A, 'pong');
    // The plugin lands as the prompt goes out, after a setup call's event.
    const client = sendingClient(
      dir,
      (index) => {
        if (index === 0) dropPlugin(dir);
      },
      turn[0]
    );
    const { provider, recycle } = harness({ [dir]: client });
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('a', { permissionMode: 'default', cwd: dir });

    const events = await drain(runtime.sendMessage('a', 'clone it', { cwd: dir }));
    expect(client.app.agents).toHaveBeenCalled();
    expect(seen(events)).toEqual({ text: '', errors: [PLUGIN_RESTART_MESSAGE], done: true });
    expect(recycle).toHaveBeenCalledTimes(1);
  });

  it('checks only the first event; plugins that land later wait for the turn to end', async () => {
    const dir = repo('northwind-widgets');
    const client = sendingClient(dir, (index) => {
      if (index === 1) dropPlugin(dir);
    });
    const { provider, recycle, restart } = harness({ [dir]: client });
    restart.next.resolve();
    const runtime = new OpenCodeRuntime({ provider });
    runtime.ensureSession('a', { permissionMode: 'default', cwd: dir });

    const events = await drain(runtime.sendMessage('a', 'clone it', { cwd: dir }));
    expect(seen(events)).toEqual({ text: 'pong', errors: [], done: true });
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(lines.map((line) => line.folder)).toEqual([dir]);
  });
});
