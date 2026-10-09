import {
  createSupervisorUncertaintyDiagnostic,
  type SupervisorUncertaintyCode,
} from './supervisor-uncertainty-diagnostic.js';
import type { SemanticAdmissionIdentityV1 } from '@dorkos/shared/browser-semantic-schemas';
import { createDarwinEngineProcesses } from './darwin-engine-processes.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { launchDarwinSupervisorBrowser } from './darwin-supervisor-browser.js';
import type { ProcessIdentity } from '../configuration.js';
import { sameProcess } from '../lifecycle/process-journal.js';
import { completeInventory } from '../lifecycle/inventory.js';
import { AbsolutePathSchema } from '../runtime-descriptor.js';
import {
  SupervisorSeedSchema,
  SupervisorActionSchema,
  SupervisorReplySchema,
  type SupervisorOriginalChild,
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
    launcher?: Readonly<{
      executable: string;
      nodeRuntime: 'node' | 'electron-node';
    }>;
    workerPath: string;
    browserId: string;
    generation: number;
    reservationNonce: string;
  },
  originalRootFailure: () => void = () => {},
  originalRootReturned?: (root: ProcessIdentity) => void | Promise<void>,
  originalChild?: (original: SupervisorOriginalChild) => Promise<void>
) {
  const nonce = randomUUID();
  const { workerPath, launcher, ...input } = options;
  const seed = SupervisorSeedSchema.parse({
    kind: 'launch',
    nonce,
    ...input,
    ...(originalChild ? { observeOriginalChild: true } : {}),
  });
  if (seed.manager.pid !== process.pid) throw new Error('SUPERVISOR_CONTROLLER_MISMATCH');
  const baselineSubjects = new Map<string, ProcessIdentity>();
  const baselineObserver = seed.identityPreparation
    ? createDarwinEngineProcesses(seed.artifact)
    : undefined;
  const observeBaseline = baselineObserver?.observeTerminated.bind(baselineObserver);
  if (Buffer.byteLength(JSON.stringify(seed)) > 65536) throw new Error('SUPERVISOR_SEED_EXCEEDED');
  const child = spawn(
    launcher?.executable ?? process.execPath,
    [AbsolutePathSchema.parse(workerPath), '--private-darwin-browser-supervisor'],
    {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: options.profileDir,
        LANG: 'C',
        LC_ALL: 'C',
        ...(launcher?.nodeRuntime === 'electron-node' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
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
  const closeDiagnostic = createSupervisorUncertaintyDiagnostic();
  const uncertain = (code: SupervisorUncertaintyCode) => {
    state.uncertain = true;
    closeDiagnostic.note(code);
  };
  const diagnosticChunks: Uint8Array[] = [];
  let sequence = 0,
    stopped = false,
    exited = false,
    closedReport = false,
    sawReady = false,
    sawRootFailure = false,
    sawRootReturn = false;
  let reportedRoot: ProcessIdentity | undefined;
  let birth: SupervisorOriginalChild | undefined;
  let birthForward: Promise<void> | undefined;
  let birthAdmitted = false;

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
  let readyResolve!: () => void, readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => {});
  const refuse = (code: SupervisorUncertaintyCode = 'CLIENT_REFUSED') => {
    uncertain(code);
    stopped = true;
    readyReject(new Error('SUPERVISOR_UNAVAILABLE'));
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('SUPERVISOR_UNAVAILABLE'));
    }
    pending.clear();
  };
  child.on('error', () => refuse());
  child.on('message', (message: unknown) => {
    if (
      !message ||
      typeof message !== 'object' ||
      Buffer.byteLength(JSON.stringify(message)) >
        ('kind' in message && message.kind === 'semanticReply' ? 266240 : 65536)
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
    if (value.kind === 'originalChild') {
      if (
        !originalChild ||
        birth ||
        stopped ||
        sawReady ||
        value.browserId !== seed.browserId ||
        value.generation !== seed.generation ||
        value.reservationNonce !== seed.reservationNonce ||
        !sameProcess(value.original.manager, seed.manager) ||
        value.original.supervisor.pid !== child.pid ||
        value.original.root.pid === value.original.supervisor.pid ||
        value.original.root.pid === value.original.manager.pid
      ) {
        refuse();
        return;
      }
      let identities: readonly ProcessIdentity[];
      try {
        identities = completeInventory(
          { status: 'complete', identities: value.original.identities },
          value.original.root
        );
      } catch {
        refuse();
        return;
      }
      birth = Object.freeze({
        identities,
        complete: value.original.complete,
        root: Object.freeze({ ...value.original.root }),
        supervisor: Object.freeze({ ...value.original.supervisor }),
        manager: Object.freeze({ ...value.original.manager }),
      });
      const original = birth;
      birthForward = Promise.resolve().then(async () => {
        await originalChild(original);
        if (stopped || !original.complete) throw new Error('SUPERVISOR_STOPPED');
        birthAdmitted = true;
        await send({
          kind: 'originalChildObserved',
          nonce,
          reservationNonce: seed.reservationNonce,
          browserId: seed.browserId,
          generation: seed.generation,
          original,
        });
      });
      state.forwards.add(birthForward);
      void birthForward.then(
        () => state.forwards.delete(birthForward!),
        (error) => {
          // Preserve an actual receiver's undefined/false rejection before generic fencing.
          readyReject(error);
          state.forwards.delete(birthForward!);
          refuse();
        }
      );
      return;
    }
    if (value.kind === 'nativeBaselineObserved') {
      if (!seed.identityPreparation) {
        refuse();
        return;
      }
      for (const identity of value.identities) {
        const key = identity.pid + ':' + identity.birth;
        if (!baselineSubjects.has(key) && baselineSubjects.size >= 512) {
          refuse();
          return;
        }
        baselineSubjects.set(key, Object.freeze({ ...identity }));
      }
      return;
    }
    if (value.kind === 'rootFailure') {
      if (sawRootFailure || !reportedRoot || !sameProcess(reportedRoot, value.root)) {
        refuse();
        return;
      }
      sawRootFailure = true;
      uncertain('CLIENT_ROOT_FAILURE');
      stopped = true;
      try {
        originalRootFailure();
      } catch {
        refuse();
      }
      return;
    }
    if (value.kind === 'custodyFault') {
      uncertain('CLIENT_CUSTODY_FAULT');
      stopped = true;
      return;
    }
    if (value.kind === 'ready') {
      if (
        (originalChild &&
          (!birth ||
            !birthAdmitted ||
            !sameProcess(birth.root, value.root) ||
            !sameProcess(birth.supervisor, value.supervisor))) ||
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
      reportedRoot = Object.freeze({
        pid: Number(root.pid),
        birth: root.birth,
      });
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
          refuse('CLIENT_ROOT_FORWARD_REFUSED');
        }
      );
      return;
    }
    pending.delete(value.sequence);
    clearTimeout(request.timer);
    if (value.kind === 'semanticEditBegun' && request.action === 'semanticBeginEdit')
      request.resolve(value.target);
    else if (value.kind === 'semanticEditStepped' && request.action === 'semanticEditPhase')
      request.resolve(undefined);
    else if (value.kind === 'semanticEditFinished' && request.action === 'semanticFinishEdit')
      request.resolve(value.result);
    else if (value.kind === 'semanticTargeted' && request.action === 'semanticTarget')
      request.resolve(value.target);
    else if (value.kind === 'semanticChanged' && request.action === 'semanticChanges')
      request.resolve(value.changes);
    else if (value.kind === 'semanticReply' && request.action === 'semanticRead')
      request.resolve(value.snapshot);
    else if (value.kind === 'semanticResolved' && request.action === 'semanticResolve')
      request.resolve(value.current);
    else if (
      value.kind === 'reply' &&
      ((request.action === 'list' && Array.isArray(value.value)) ||
        (request.action === 'navigate' && !Array.isArray(value.value)))
    )
      request.resolve(value.value);
    else if (value.kind === 'closed' && request.action === 'close') {
      closedReport = value.returned === true && (!originalRootReturned || sawRootReturn);
      request.resolve(closedReport);
    } else {
      uncertain('CLIENT_REPLY_REFUSED');
      request.reject(new Error('SUPERVISOR_REFUSED'));
    }
  });
  const terminal = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      if (code !== 0 || signal !== null) uncertain('CLIENT_EXIT');
    });
    child.once('close', () => {
      if (!exited) uncertain('CLIENT_TERMINAL');
      resolve();
    });
  });
  const drain = async (stream: Readable | null) => {
    if (!stream) {
      uncertain('CLIENT_PIPE_MISSING');
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
        if (bytes > 262144) uncertain('CLIENT_PIPE_OVERFLOW');
      }
    } catch {
      uncertain('CLIENT_PIPE_ERROR');
    }
    await originalClose;
    if (!eof || !closed) uncertain('CLIENT_PIPE_EOF');
  };
  const completion = Promise.all([terminal, drain(child.stdout), drain(child.stderr)]).then(
    async () => {
      const forwards = await Promise.allSettled([...state.forwards]);
      if (seed.identityPreparation) {
        if (!observeBaseline || !baselineSubjects.size) uncertain('CLIENT_BASELINE_MISSING');
        const results = await Promise.allSettled(
          [...baselineSubjects.values()].map((identity) =>
            observeBaseline!(identity, new AbortController().signal)
          )
        );
        if (
          results.some((result) => result.status !== 'fulfilled' || result.value.status !== 'dead')
        )
          uncertain('CLIENT_BASELINE_RETURN');
      }
      if (forwards.some((result) => result.status === 'rejected')) uncertain('CLIENT_ROOT_FORWARD');
      state.pending = state.sends.size !== 0;
      if (state.pending) uncertain('CLIENT_SENDS_PENDING');
      if (!closedReport) uncertain('CLIENT_CLOSED_REPORT');
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
      if (originalChild) await birthForward;
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
    diagnostics: () => {
      const original = Buffer.concat(diagnosticChunks).toString('utf8');
      const fixed = closeDiagnostic.line();
      return original + (fixed ? '\n' + fixed : '');
    },
    list: () => request({ kind: 'list' }),
    navigate: (tab: number, url: string) => request({ kind: 'navigate', tab, url }),
    semanticBeginEdit: (
      tab: number,
      requestId: string,
      leaseId: string,
      nodeRef: string,
      actorKey: string,
      grantKey: string
    ) =>
      request({
        kind: 'semanticBeginEdit',
        tab,
        requestId,
        leaseId,
        nodeRef,
        actorKey,
        grantKey,
      }),
    semanticEditPhase: (
      tab: number,
      requestId: string,
      actorKey: string,
      grantKey: string,
      phase: 'idle' | 'input' | 'selection'
    ) =>
      request({
        kind: 'semanticEditPhase',
        tab,
        requestId,
        actorKey,
        grantKey,
        phase,
      }),
    semanticFinishEdit: (tab: number, requestId: string, actorKey: string, grantKey: string) =>
      request({
        kind: 'semanticFinishEdit',
        tab,
        requestId,
        actorKey,
        grantKey,
      }),
    semanticTarget: (
      tab: number,
      leaseId: string,
      nodeRef: string,
      actorKey: string,
      grantKey: string
    ) =>
      request({
        kind: 'semanticTarget',
        tab,
        leaseId,
        nodeRef,
        actorKey,
        grantKey,
      }),
    semanticChanges: (tab: number, actorKey: string, grantKey: string) =>
      request({ kind: 'semanticChanges', tab, actorKey, grantKey }),
    semanticRead: (
      tab: number,
      identity: SemanticAdmissionIdentityV1,
      actorKey: string,
      grantKey: string
    ) => request({ kind: 'semanticRead', tab, identity, actorKey, grantKey }),
    semanticResolve: (
      tab: number,
      leaseId: string,
      nodeRef: string,
      actorKey: string,
      grantKey: string
    ) =>
      request({
        kind: 'semanticResolve',
        tab,
        leaseId,
        nodeRef,
        actorKey,
        grantKey,
      }),
    close() {
      stopped = true;
      if (closing) return closing;
      const original = (async () => {
        try {
          await request({ kind: 'close' }, true);
        } catch {
          uncertain('CLIENT_CLOSE_REQUEST');
        }
        // Worker-origin disconnect owns aggregate close accounting, including explicit refusal.
        return completion;
      })();
      state.cleanup = original;
      closing = new Promise((resolve) => {
        const timer = setTimeout(() => {
          closeDiagnostic.note('CLIENT_CLOSE_REQUEST');
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
