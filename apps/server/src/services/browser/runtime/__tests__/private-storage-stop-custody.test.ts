import { ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { expect, it, vi, type MockInstance } from 'vitest';
import {
  resolveInstalledRuntimeConfiguration,
  verifyInstalledNativeJournal,
} from '@dorkos/browser/runtime-installation';
import { PublicNativeInputSchema } from './public-native-input.js';
import { withOriginalInstalledBrowserRound } from './private-storage-runner.fixture.js';
import { createOriginalStorageOrigin } from './private-storage-origin.fixture.js';

const ports = vi.hoisted(() => ({
  child: undefined as import('node:child_process').ChildProcess | undefined,
  first: undefined as unknown,
  logs: [] as import('node:fs/promises').FileHandle[],
  server: undefined as import('node:http').Server | undefined,
  sockets: [] as import('node:net').Socket[],
  projectionClose: vi.fn(async () => {}),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: () => {
    if (!ports.child) throw new Error('TEST_ORIGINAL_CHILD_REQUIRED');
    return ports.child;
  },
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      ports.logs.push(handle);
      return handle;
    },
  };
});
vi.mock('node:http', async (original) => {
  const http = await original<typeof import('node:http')>();
  return {
    ...http,
    createServer: new Proxy(http.createServer, {
      apply(target, receiver, args) {
        const server: ReturnType<typeof http.createServer> = Reflect.apply(target, receiver, args);
        ports.server = server;
        server.on('connection', (socket) => ports.sockets.push(socket));
        return server;
      },
    }),
  };
});
vi.mock('./qualification-grant.fixture.js', () => ({
  captureOriginalQualificationGrant: async () => undefined,
}));
vi.mock('./private-projected-resource-bank.fixture.js', () => ({
  createOriginalProjectedResourceBank: () => ({
    captureCli: async () => {
      throw ports.first;
    },
    originalKnownBirths: () => [],
  }),
}));
vi.mock('../private-native-projection.js', () => ({
  createOriginalNativeProjectionReceiver: () => ({ close: ports.projectionClose }),
}));
vi.mock('@dorkos/browser/runtime-installation', () => ({
  resolveInstalledRuntimeConfiguration: async () => ({}),
  createRuntimeInstallation: () => ({}),
  verifyInstalledNativeJournal: async () => ({
    manager: { pid: 900001, birth: 'controlled-manager' },
    processes: {},
  }),
}));
const turn = () => new Promise<void>((yes) => setImmediate(yes));

it.each([false, undefined])(
  'a thrown exact CLI stop still joins held original return, both EOFs and logs after primary %s',
  async (primary) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'storage-stop-custody-')));
    const stdout = new PassThrough(),
      stderr = new PassThrough(),
      child = new ChildProcess();
    Object.defineProperties(child, {
      pid: { value: 900002 },
      stdout: { value: stdout },
      stderr: { value: stderr },
    });
    ports.child = child;
    ports.first = primary;
    ports.logs = [];
    ports.projectionClose.mockClear();
    let entered!: () => void;
    const stopped = new Promise<void>((yes) => {
      entered = yes;
    });
    const stopFailure = new Error('ORIGINAL_STOP_THROW');
    const kill = vi.spyOn(child, 'kill').mockImplementation(() => {
      entered();
      throw stopFailure;
    });
    const configuration = await resolveInstalledRuntimeConfiguration(
      pathToFileURL('/controlled-cli'),
      root
    );
    const native = await verifyInstalledNativeJournal(configuration);
    const input = PublicNativeInputSchema.parse({
      kind: 'production-public-native-acceptance',
      home: root,
      cliEntry: '/controlled-cli',
      cliSHA256: 'a'.repeat(64),
      emittedGuard: '/controlled-guard',
      emittedGuardSHA256: 'b'.repeat(64),
      workspaceId: 'controlled-workspace',
      email: 'public-native@dork.test',
      password: 'public-native-fixture-password-only',
      port: 4242,
    });
    const retained = vi.fn(async (_report: unknown) => {}),
      body = vi.fn(async () => {});
    let settled = false;
    const original = withOriginalInstalledBrowserRound(
      {
        input,
        node: process.execPath,
        artifacts: root,
        round: 0,
        native,
        signal: new AbortController().signal,
        current() {},
        retainRetirement: retained,
      },
      body
    ).finally(() => {
      settled = true;
    });
    const failed = expect(original).rejects.toBe(primary);
    void failed.catch(() => {});
    try {
      await stopped;
      await turn();
      expect(settled).toBe(false);
      expect(kill).toHaveBeenCalledOnce();
      expect(ports.projectionClose).not.toHaveBeenCalled();
      stdout.end();
      await turn();
      expect(settled).toBe(false);
      stderr.end();
      await turn();
      expect(settled).toBe(false);
      child.emit('close', 0, null);
      await failed;
      expect(body).not.toHaveBeenCalled();
      expect(ports.projectionClose).toHaveBeenCalledOnce();
      expect(ports.logs).toHaveLength(2);
      expect(ports.logs.every((handle) => handle.fd === -1)).toBe(true);
      expect(retained).toHaveBeenCalledOnce();
    } finally {
      stdout.end();
      stderr.end();
      child.emit('close', 0, null);
      await Promise.allSettled([original, failed]);
      await Promise.allSettled(
        ports.logs.filter((handle) => handle.fd !== -1).map((handle) => handle.close())
      );
      kill.mockRestore();
      ports.child = undefined;
      await rm(root, { recursive: true, force: true });
    }
  }
);

it.each([false, undefined])(
  'a thrown first original socket stop %s attempts the second and joins the real server callback',
  async (value) => {
    ports.sockets = [];
    const origin = await createOriginalStorageOrigin(new AbortController().signal);
    const server = ports.server;
    if (!server) throw new Error('TEST_ORIGINAL_SERVER_REQUIRED');
    const clients = [new Socket(), new Socket()];
    const originalDestroy = Socket.prototype.destroy;
    const clientReturns = clients.map(
      (client) => new Promise<void>((yes) => client.once('close', yes))
    );
    let clientFailure: { value: unknown } | undefined;
    for (const client of clients)
      client.on('error', (error) => {
        clientFailure ??= { value: error };
      });
    const accepted = new Promise<void>((yes) =>
      server.on('connection', () => {
        if (ports.sockets.length === 2) yes();
      })
    );
    let requests = 0;
    const receiving = new Promise<void>((yes) =>
      server.on('request', () => {
        if (++requests === 2) yes();
      })
    );
    const owned: {
      original?: Promise<void>;
      failed?: Promise<void>;
      thrown?: MockInstance<Socket['destroy']>;
      secondStop?: MockInstance<Socket['destroy']>;
      close?: MockInstance<typeof server.close>;
      callbackEntered?: Promise<void>;
      release?: () => void;
    } = {};
    try {
      for (const client of clients) {
        client.connect(Number(new URL(origin.origin).port), '127.0.0.1');
        // Original bounded POST readers remain live until cleanup destroys their sockets.
        client.write('POST /report HTTP/1.1\r\nHost: fixture\r\nContent-Length: 100\r\n\r\n{');
      }
      await accepted;
      await receiving;
      await turn();
      if (clientFailure) throw clientFailure.value;
      const [first, second] = ports.sockets;
      if (!first || !second) throw new Error('TEST_ORIGINAL_SOCKETS_REQUIRED');
      const firstDestroy = first.destroy.bind(first);
      owned.thrown = vi.spyOn(first, 'destroy').mockImplementation(() => {
        throw value;
      });
      owned.secondStop = vi.spyOn(second, 'destroy');
      const originalClose = server.close.bind(server);
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((yes) => {
        release = yes;
      });
      owned.release = release;
      owned.callbackEntered = new Promise<void>((yes) => {
        entered = yes;
      });
      owned.close = vi.spyOn(server, 'close').mockImplementation((callback) =>
        originalClose((error) => {
          entered();
          void held.then(() => callback?.(error));
        })
      );
      let settled = false;
      owned.original = origin.close().finally(() => {
        settled = true;
      });
      owned.failed = expect(owned.original).rejects.toBe(value);
      void owned.failed.catch(() => {});
      await turn();
      expect(owned.thrown).toHaveBeenCalledOnce();
      expect(owned.secondStop).toHaveBeenCalledOnce();
      expect(owned.close).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      firstDestroy();
      await owned.callbackEntered;
      expect(settled).toBe(false);
      release();
      await owned.failed;
    } finally {
      owned.original ??= origin.close();
      void owned.original.catch(() => {});
      for (const socket of [...ports.sockets, ...clients])
        try {
          Reflect.apply(originalDestroy, socket, []);
        } catch (error) {
          clientFailure ??= { value: error };
        }
      owned.release?.();
      await Promise.allSettled([
        owned.original,
        ...(owned.failed ? [owned.failed] : []),
        ...(owned.callbackEntered ? [owned.callbackEntered] : []),
        ...clientReturns,
      ]);
      owned.thrown?.mockRestore();
      owned.secondStop?.mockRestore();
      owned.close?.mockRestore();
    }
    if (clientFailure) throw clientFailure.value;
  }
);
