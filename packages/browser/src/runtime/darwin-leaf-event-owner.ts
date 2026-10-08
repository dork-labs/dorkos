import type { ProcessIdentity } from '../configuration.js';
import { sameProcess } from '../lifecycle/process-journal.js';
import {
  acceptsDarwinOwnedChildReturn,
  createDarwinOwnedChildLauncher,
} from './darwin-owned-child.js';
import type { DarwinChildrenBatch } from './darwin-process-observer.js';

interface Watch {
  identity: ProcessIdentity;
  epoch: number;
  admitted: boolean;
  forked: boolean;
  exited: boolean;
  consumed: boolean;
}
interface State {
  boot: string;
  first?: { value: unknown };
  watches: Map<number, Watch>;
  barrier(): Promise<void>;
  closed: boolean;
}
/** Private event lifetime; terminal proof never authorizes signaling or profile release. */
export interface DarwinLeafEventOwner {
  identity(): Promise<ProcessIdentity>;
  enroll(identity: ProcessIdentity, epoch: number): Promise<void>;
  close(): Promise<void>;
}
const owners = new WeakMap<DarwinLeafEventOwner, State>();
function requireOriginalEventFailureFree(state: State): void {
  if (state.first) throw state.first.value;
}

/** A consumed exact exit makes any later positive executable fact contradictory. */
export function hasOriginalLeafTerminal(
  owner: DarwinLeafEventOwner,
  identity: ProcessIdentity
): boolean {
  const state = owners.get(owner);
  if (!state) throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
  requireOriginalEventFailureFree(state);
  return [...state.watches.values()].some(
    (watch) => watch.consumed && sameProcess(watch.identity, identity)
  );
}
/** Snapshot retained receiver facts only; no barrier, native read or terminal authority is acquired. */
export function originalLeafDiagnostic(owner: DarwinLeafEventOwner, identity: ProcessIdentity) {
  const state = owners.get(owner);
  if (!state) throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
  const watch = [...state.watches.values()].find((value) => sameProcess(value.identity, identity));
  return Object.freeze({
    watched: !!watch,
    enrolled: watch?.admitted ?? false,
    forked: watch?.forked ?? false,
    exited: watch?.exited ?? false,
    consumed: watch?.consumed ?? false,
    receiverFailed: !!state.first,
    receiverClosed: state.closed,
  });
}
/** Qualify only both original parent ESRCH reads after a prior positive sweep.
 * No unknown inspect, boot change, nonempty partial tree or foreign failure is healed. */
export async function consumeOriginalLeafTerminal(
  owner: DarwinLeafEventOwner,
  identity: ProcessIdentity,
  epoch: number,
  batch: DarwinChildrenBatch
): Promise<boolean> {
  const state = owners.get(owner);
  if (!state) throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
  requireOriginalEventFailureFree(state);
  if (
    state.closed ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    batch.complete ||
    batch.processes.length ||
    batch.parentBefore ||
    batch.parentAfter ||
    `${batch.bootSeconds}:${batch.bootMicroseconds}` !== state.boot ||
    batch.parentObservation?.beforeError !== 3 ||
    batch.parentObservation.afterError !== 3
  )
    return false;
  await state.barrier();
  requireOriginalEventFailureFree(state);
  if (state.closed) return false;
  const watch = [...state.watches.values()].find((value) => sameProcess(value.identity, identity));
  if (
    !watch ||
    !watch.admitted ||
    watch.forked ||
    !watch.exited ||
    watch.consumed ||
    epoch <= watch.epoch
  )
    return false;
  watch.consumed = true;
  return true;
}

/** One original verified native child, its stdin jobs, both pipes and terminal
 * stay retained by the journal worker until the same owner's close joins them. */
export async function openDarwinLeafEventOwner(
  options: Readonly<{
    artifact: Readonly<{ path: string; sha256: string }>;
    manager: ProcessIdentity;
    boot: Readonly<{ seconds: string; microseconds: string }>;
  }>
): Promise<DarwinLeafEventOwner> {
  const boot = Object.freeze({ ...options.boot });
  if (
    !/^[1-9][0-9]{0,19}$/.test(boot.seconds) ||
    !/^(0|[1-9][0-9]{0,5})$/.test(boot.microseconds) ||
    BigInt(boot.microseconds) >= 1000000n ||
    BigInt(boot.seconds) > 18446744073709551615n
  )
    throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
  const original = await createDarwinOwnedChildLauncher(options).launch({
    executable: options.artifact.path,
    argv: ['watch-leaves'],
    cwd: process.cwd(),
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdin: 'pipe',
  });
  const stdin = original.child.stdin;
  const stdout = original.child.stdout;
  const jobs = new Set<Promise<void>>();
  const replies = new Map<
    string,
    { resolve(result: string): void; reject(value: unknown): void }
  >();
  const state: State = {
    boot: `${boot.seconds}:${boot.microseconds}`,
    watches: new Map(),
    barrier: async () => {},
    closed: false,
  };
  let closePromise: Promise<void> | undefined;
  let nextBarrier = 0,
    retainedBytes = 0;
  let pending: Buffer = Buffer.alloc(0);
  const fail = (value: unknown) => {
    state.first ??= { value };
    for (const reply of replies.values()) reply.reject(state.first.value);
    replies.clear();
  };
  const check = () => {
    requireOriginalEventFailureFree(state);
    if (state.closed) throw new Error('LEAF_EVENT_OWNER_CLOSED');
  };
  const send = (kind: 'watch' | 'barrier', slot: number, line: string): Promise<string> => {
    check();
    let resolve!: (value: string) => void, reject!: (value: unknown) => void;
    const response = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void response.catch(() => {});
    const key = `${kind}:${slot}`;
    if (replies.has(key)) throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
    replies.set(key, { resolve, reject });
    const writing = new Promise<void>((yes, no) => {
      if (!stdin) {
        no(new Error('LEAF_EVENT_OWNER_UNAVAILABLE'));
        return;
      }
      try {
        stdin.write(line + '\n', (error) => (error ? no(error) : yes()));
      } catch (value) {
        no(value);
      }
    });
    jobs.add(writing);
    void writing.then(
      () => jobs.delete(writing),
      (value) => {
        fail(value);
        jobs.delete(writing);
      }
    );
    return Promise.all([writing, response]).then(([, value]) => value);
  };
  state.barrier = async () => {
    if (nextBarrier === 2147483647) throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
    const response = await send('barrier', ++nextBarrier, `B ${nextBarrier}`);
    if (response !== 'settled') throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
  };
  if (!stdin || !stdout) fail(new Error('LEAF_EVENT_OWNER_UNAVAILABLE'));
  original.child.on('error', fail);
  stdin?.on('error', fail);
  stdout?.on('error', fail);
  stdout?.on('data', (chunk: Buffer) => {
    try {
      if (state.first) return;
      retainedBytes += chunk.length;
      if (retainedBytes > 256 * 1024) throw new Error('LEAF_EVENT_OVERFLOW');
      pending = Buffer.concat([pending, chunk]);
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        if (newline > 256) throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
        const row: unknown = JSON.parse(pending.subarray(0, newline).toString('utf8'));
        pending = pending.subarray(newline + 1);
        if (
          !row ||
          typeof row !== 'object' ||
          Object.keys(row).sort().join(',') !== 'kind,result,slot'
        )
          throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
        const value = row as { kind: unknown; slot: unknown; result: unknown };
        if (!Number.isSafeInteger(value.slot) || (value.slot as number) < 1)
          throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
        const slot = value.slot as number;
        if (value.kind === 'event') {
          const watch = state.watches.get(slot);
          if (!watch || (value.result !== 'fork' && value.result !== 'exit'))
            throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
          if (value.result === 'fork') watch.forked = true;
          else {
            if (watch.exited) throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
            watch.exited = true;
          }
        } else {
          if (value.kind !== 'watch' && value.kind !== 'barrier')
            throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
          const reply = replies.get(`${value.kind}:${slot}`);
          if (
            !reply ||
            (value.kind === 'watch'
              ? value.result !== 'leaf' && value.result !== 'refused'
              : value.result !== 'settled')
          )
            throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
          if (value.kind === 'watch') {
            const watch = state.watches.get(slot);
            if (!watch) throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
            watch.admitted = value.result === 'leaf' && !watch.forked && !watch.exited;
          }
          replies.delete(`${value.kind}:${slot}`);
          reply.resolve(value.result as string);
        }
      }
      if (pending.length > 256) throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
    } catch (value) {
      fail(value);
    }
  });
  stdout?.once('end', () => {
    if (!state.closed || pending.length || replies.size)
      fail(new Error('LEAF_EVENT_PIPE_UNCERTAIN'));
  });
  void original.completion().then((receipt) => {
    if (!state.closed || receipt.firstCause !== null) fail(new Error('LEAF_EVENT_CHILD_UNCERTAIN'));
  }, fail);
  const owner: DarwinLeafEventOwner = Object.freeze({
    identity: () => original.identity(),
    async enroll(identity: ProcessIdentity, epoch: number) {
      check();
      if (!Number.isSafeInteger(epoch) || epoch < 0)
        throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
      if ([...state.watches.values()].some((watch) => watch.identity.pid === identity.pid)) return;
      if (state.watches.size === 512) throw new Error('LEAF_EVENT_OVERFLOW');
      const birth = /^darwin-bsd-start:([1-9][0-9]{0,19}):(0|[1-9][0-9]{0,5})$/.exec(
        identity.birth
      );
      if (
        !birth ||
        BigInt(birth[1]) > 18446744073709551615n ||
        !Number.isSafeInteger(identity.pid) ||
        identity.pid < 1 ||
        identity.pid > 2147483647
      )
        throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
      const slot = state.watches.size + 1;
      const watch: Watch = {
        identity: Object.freeze({ ...identity }),
        epoch,
        admitted: false,
        forked: false,
        exited: false,
        consumed: false,
      };
      state.watches.set(slot, watch);
      const result = await send(
        'watch',
        slot,
        `W ${slot} ${identity.pid} ${birth[1]} ${birth[2]} ${boot.seconds} ${boot.microseconds}`
      );
      check();
      if (result !== 'leaf' && result !== 'refused')
        throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
    },
    close() {
      if (closePromise) return closePromise;
      state.closed = true;
      let resolve!: () => void, reject!: (value: unknown) => void;
      closePromise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void closePromise.catch(() => {});
      // Publish the original close duty before entering reentrant stdin.end.
      void (async () => {
        try {
          if (!stdin) throw new Error('LEAF_EVENT_OWNER_UNAVAILABLE');
          stdin.end();
        } catch (value) {
          fail(value);
        }
        const results = await Promise.allSettled([
          ...jobs,
          original.completion(),
          original.returned(),
        ]);
        for (const result of results) if (result.status === 'rejected') fail(result.reason);
        const returned = results.at(-1);
        if (
          !returned ||
          returned.status !== 'fulfilled' ||
          !acceptsDarwinOwnedChildReturn(original, returned.value)
        )
          fail(new Error('LEAF_EVENT_RETURN_UNCERTAIN'));
        requireOriginalEventFailureFree(state);
      })().then(resolve, reject);
      return closePromise;
    },
  });
  owners.set(owner, state);
  return owner;
}
