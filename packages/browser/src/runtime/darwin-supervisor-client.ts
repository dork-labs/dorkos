import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { launchDarwinSupervisorBrowser } from './darwin-supervisor-browser.js';
import type { ProcessIdentity } from '../configuration.js';
import { sameProcess } from '../lifecycle/process-journal.js';
import { AbsolutePathSchema } from '../runtime-descriptor.js';
import {
  SupervisorSeedSchema,
  SupervisorActionSchema,
  SupervisorReplySchema,
} from './darwin-supervisor-protocol.js';

type State = {
  child: ChildProcess;
  uncertain: boolean;
  pending: boolean;
  sends: Set<Promise<void>>;
  forwards: Set<Promise<void>>;
  cleanup?: Promise<unknown>;
  startup?: Promise<void>;
};
const retained = new Set<State>();
/** Controller facade owns its original supervisor; IPC results are data, never reuse capabilities. */
export async function startDarwinSupervisorClient(
  options: Parameters<typeof launchDarwinSupervisorBrowser>[0] & {
    workerPath: string;
    browserId: string;
    generation: number;
    reservationNonce: string;
  },
  originalRootFailure: () => void = () => {},
  originalRootReturned?: (root: ProcessIdentity) => void | Promise<void>
) {
  const nonce = randomUUID();
  const { workerPath, ...input } = options;
  const seed = SupervisorSeedSchema.parse({ kind: 'launch', nonce, ...input });
  if (seed.manager.pid !== process.pid) throw new Error('SUPERVISOR_CONTROLLER_MISMATCH');
  if (Buffer.byteLength(JSON.stringify(seed)) > 65536) throw new Error('SUPERVISOR_SEED_EXCEEDED');
  const child = spawn(
    process.execPath,
    [AbsolutePathSchema.parse(workerPath), '--private-darwin-browser-supervisor'],
    {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { PATH: '/usr/bin:/bin', HOME: options.profileDir, LANG: 'C', LC_ALL: 'C' },
    }
  );
  const state: State = {
    child,
    uncertain: false,
    pending: true,
    sends: new Set(),
    forwards: new Set(),
  };
  retained.add(state);
  const diagnosticChunks: Uint8Array[] = [];
  let sequence = 0,
    stopped = false,
    exited = false,
    closedReport = false,
    sawReady = false,
    sawRootFailure = false,
    sawRootReturn = false;
  let reportedRoot: ProcessIdentity | undefined;
  let reportedSupervisor: ProcessIdentity | undefined,
    reportedProxyURL = '',
    reportedEndpointURL = '';
  const pending = new Map<
    number,
    {
      action: string;
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => {});
  const refuse = () => {
    state.uncertain = true;
    stopped = true;
    readyReject(new Error('SUPERVISOR_UNAVAILABLE'));
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('SUPERVISOR_UNAVAILABLE'));
    }
    pending.clear();
  };
  child.on('error', refuse);
  child.on('message', (message: unknown) => {
    if (
      !message ||
      typeof message !== 'object' ||
      Buffer.byteLength(JSON.stringify(message)) > 65536
    ) {
      refuse();
      return;
    }
    const parsed = SupervisorReplySchema.safeParse(message);
    if (!parsed.success) {
      refuse();
      return;
    }
    const value = parsed.data;
    if (value.nonce !== nonce) {
      refuse();
      return;
    }
    if (value.kind === 'rootFailure') {
      if (sawRootFailure || !reportedRoot || !sameProcess(reportedRoot, value.root)) {
        refuse();
        return;
      }
      sawRootFailure = true;
      state.uncertain = true;
      stopped = true;
      try {
        originalRootFailure();
      } catch {
        refuse();
      }
      return;
    }
    if (value.kind === 'custodyFault') {
      state.uncertain = true;
      stopped = true;
      return;
    }
    if (value.kind === 'ready') {
      if (
        value.supervisor.pid !== child.pid ||
        sawReady ||
        value.browserId !== options.browserId ||
        value.generation !== options.generation ||
        value.reservationNonce !== seed.reservationNonce ||
        stopped
      ) {
        refuse();
        return;
      }
      const root = value.root;
      reportedRoot = Object.freeze({ pid: Number(root.pid), birth: root.birth });
      reportedSupervisor = Object.freeze({ ...value.supervisor });
      reportedProxyURL = value.proxyURL;
      reportedEndpointURL = value.endpointURL;
      sawReady = true;
      readyResolve();
      return;
    }
    if (typeof value.sequence !== 'number') {
      refuse();
      return;
    }
    const request = pending.get(value.sequence);
    if (!request) {
      refuse();
      return;
    }
    if (value.kind === 'rootReturned') {
      if (
        sawRootReturn ||
        request.action !== 'close' ||
        !sawReady ||
        !reportedRoot ||
        !sameProcess(reportedRoot, value.root)
      ) {
        refuse();
        return;
      }
      sawRootReturn = true;
      // Register before the original receiver can reenter close or reject, including undefined.
      const forward = Promise.resolve().then(() =>
        originalRootReturned?.(Object.freeze({ ...value.root }))
      );
      state.forwards.add(forward);
      void forward.then(
        () => state.forwards.delete(forward),
        () => {
          state.forwards.delete(forward);
          refuse();
        }
      );
      return;
    }
    pending.delete(value.sequence);
    clearTimeout(request.timer);
    if (
      value.kind === 'reply' &&
      ((request.action === 'list' && Array.isArray(value.value)) ||
        (request.action === 'navigate' && !Array.isArray(value.value)))
    )
      request.resolve(value.value);
    else if (value.kind === 'closed' && request.action === 'close') {
      closedReport = value.returned === true && (!originalRootReturned || sawRootReturn);
      request.resolve(closedReport);
    } else {
      state.uncertain = true;
      request.reject(new Error('SUPERVISOR_REFUSED'));
    }
  });
  const terminal = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      if (code !== 0 || signal !== null) state.uncertain = true;
    });
    child.once('close', () => {
      if (!exited) state.uncertain = true;
      resolve();
    });
  });
  const drain = async (stream: Readable | null) => {
    if (!stream) {
      state.uncertain = true;
      return;
    }
    let eof = false,
      closed = false,
      bytes = 0;
    const originalClose = new Promise<void>((resolve) =>
      stream.once('close', () => {
        closed = true;
        resolve();
      })
    );
    stream.once('end', () => {
      eof = true;
    });
    try {
      for await (const chunk of stream) {
        const length = Math.min(Buffer.byteLength(chunk), Math.max(0, 262144 - bytes));
        if (length) diagnosticChunks.push(Uint8Array.from(Buffer.from(chunk).subarray(0, length)));
        bytes += Buffer.byteLength(chunk);
        if (bytes > 262144) state.uncertain = true;
      }
    } catch {
      state.uncertain = true;
    }
    await originalClose;
    if (!eof || !closed) state.uncertain = true;
  };
  const completion = Promise.all([terminal, drain(child.stdout), drain(child.stderr)]).then(
    async () => {
      const forwards = await Promise.allSettled([...state.forwards]);
      if (forwards.some((result) => result.status === 'rejected')) state.uncertain = true;
      state.pending = state.sends.size !== 0;
      if (state.pending) state.uncertain = true;
      if (!closedReport) state.uncertain = true;
      if (!state.uncertain) retained.delete(state);
      if (pending.size) refuse();
      readyReject(new Error('SUPERVISOR_UNAVAILABLE'));
      return { pending: state.pending, uncertain: state.uncertain } as const;
    }
  );
  const send = (value: object) => {
    const original = new Promise<void>((resolve, reject) => {
      child.send(value, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    state.sends.add(original);
    void original.then(
      () => state.sends.delete(original),
      () => {
        state.sends.delete(original);
        refuse();
      }
    );
    return original;
  };
  const request = (action: object, terminalRequest = false): Promise<unknown> => {
    if ((stopped && !terminalRequest) || !state.pending || pending.size >= 8)
      return Promise.reject(new Error('SUPERVISOR_STOPPED'));
    const parsed = SupervisorActionSchema.parse(action);
    const id = ++sequence;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        refuse();
      }, 10000);
      pending.set(id, { action: parsed.kind, resolve, reject, timer });
    });
    void send({ kind: 'command', nonce, sequence: id, action: parsed }).catch(() => {});
    return result;
  };
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const original = (async () => {
      await send(seed);
      await ready;
    })();
    state.startup = original;
    await Promise.race([
      original,
      new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(() => {
          refuse();
          reject(new Error('SUPERVISOR_STARTUP_EXPIRED'));
        }, 15000);
      }),
    ]);
  } catch (error) {
    // Request worker-origin closure; neither the send callback nor original terminal is fabricated.
    void request({ kind: 'close' }, true).catch(() => {});
    throw error;
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
  }
  let closing: Promise<Readonly<{ pending: boolean; uncertain: boolean }>> | undefined;
  return Object.freeze({
    // IPC data for independent native correlation; it is never an original process capability.
    reportedRoot: reportedRoot!,
    reportedSupervisor: reportedSupervisor!,
    reportedProxyURL,
    reportedEndpointURL,
    diagnostics: () => Buffer.concat(diagnosticChunks).toString('utf8'),
    list: () => request({ kind: 'list' }),
    navigate: (tab: number, url: string) => request({ kind: 'navigate', tab, url }),
    close() {
      stopped = true;
      if (closing) return closing;
      const original = (async () => {
        try {
          await request({ kind: 'close' }, true);
        } catch {
          state.uncertain = true;
        }
        // Worker-origin disconnect owns aggregate close accounting, including explicit refusal.
        return completion;
      })();
      state.cleanup = original;
      closing = new Promise((resolve) => {
        const timer = setTimeout(() => {
          refuse();
          resolve({ pending: state.pending, uncertain: true });
        }, 15000);
        void original.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          () => {
            clearTimeout(timer);
            refuse();
            resolve({ pending: state.pending, uncertain: true });
          }
        );
      });
      return closing;
    },
    custody: () => Object.freeze({ pending: state.pending, uncertain: state.uncertain }),
  });
}
