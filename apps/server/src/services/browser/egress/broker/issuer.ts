import { binding, type EgressBinding, type EgressPolicyOptions } from '../settings.js';
import { BrokerError } from './errors.js';
import { brokerLimits, type BrokerLimits } from './limits.js';
import { checkedClock, bounded } from './clock.js';
import { createLedger } from './ledger.js';
import { authoritySnapshot, inventorySnapshot } from './observations.js';
import {
  type AuthorityPorts,
  type AuthorityObservation,
  type InventoryObservation,
} from './authority.js';
/** Server custody identity: credentials and serialized copies cannot acquire retained-run rights. */
export interface RunHandle {
  readonly kind: 'retained-run';
}
/** An issuer-owned one-use permission; expiry and every revision are checked again at consume. */
export interface Permit {
  readonly kind: 'broker-permit';
}
/** Private original engine receiver; serialized readiness fields cannot stand in for it. */
export interface PreparedRunReceiver {
  readonly browserId: string;
  readonly browserGeneration: number;
  isAuthorityCurrent(): boolean;
}
/** Expected trusted configuration, never a positive observation of a pending browser. */
export interface RunPreparation {
  readonly runtimeIdentity: string;
  readonly authorizationEpoch: number;
  readonly policyRevision: number;
  readonly inventoryRevision: number;
  readonly receiver: PreparedRunReceiver;
}
interface RunRecord {
  binding: Readonly<EgressBinding>;
  runtime: string;
  epoch: number;
  policy: number;
  inventory: number;
  sequence: number;
  deadline: number;
  state: 'prepared' | 'active' | 'suspended' | 'terminal';
  receiver?: PreparedRunReceiver;
  ready?: () => boolean;
  listeners: Set<(state: 'suspended' | 'terminal') => void>;
  renewing: boolean;
  charge: ReturnType<ReturnType<typeof createLedger>['reserve']>;
}
interface PermitRecord {
  purpose: 'continuation' | 'revision';
  next?: AuthorityObservation;
  run: RunHandle;
  sequence: number;
  epoch: number;
  policy: number;
  inventory: number;
  deadline: number;
  expires: number;
  charge: ReturnType<ReturnType<typeof createLedger>['reserve']>;
}
/** Complete private issuer with no production authority or inventory fallback. */
export function createBrokerIssuer(options: {
  ports?: AuthorityPorts;
  now: () => number;
  limits?: Partial<Record<keyof BrokerLimits, number>>;
}) {
  const readPreparedPolicy = options.ports?.readPreparedPolicy;
  const limits = brokerLimits(options.limits);
  const ledger = createLedger(limits);
  const runs = new Map<RunHandle, RunRecord>();
  const permits = new Map<Permit, PermitRecord>();
  const invalidate = (run: RunHandle) => {
    for (const [permit, p] of permits)
      if (p.run === run) {
        permits.delete(permit);
        ledger.release(p.charge);
      }
  };
  const suspend = (run: RunHandle, terminal = false) => {
    const r = runs.get(run);
    if (!r) return;
    if (r.state === 'terminal') return;
    r.state = terminal || r.state === 'prepared' ? 'terminal' : 'suspended';
    invalidate(run);
    for (const close of [...r.listeners]) {
      try {
        close(r.state);
      } catch {
        /* Custody remains charged; closure cannot be inferred. */
      }
    }
  };
  const now = checkedClock(options.now, () => {
    for (const run of runs.keys()) suspend(run);
  });
  const get = (run: RunHandle) => {
    const r = runs.get(run);
    if (!r) throw new BrokerError('AUTHORITY_REFUSED');
    return r;
  };
  const inventory = (): InventoryObservation =>
    inventorySnapshot(options.ports?.readInventory(), now());
  const check = (run: RunHandle) => {
    const r = get(run);
    const current = now();
    if (current >= r.deadline) {
      suspend(run, true);
      throw new BrokerError('EXPIRED');
    }
    if (r.state !== 'active') throw new BrokerError('CLOSED');
    let i: InventoryObservation;
    try {
      i = inventory();
    } catch (error) {
      suspend(run);
      throw error;
    }
    if (r.state !== 'active') throw new BrokerError('CLOSED');
    if (i.revision !== r.inventory) {
      suspend(run);
      throw new BrokerError('AUTHORITY_REFUSED');
    }
    try {
      const raw = options.ports?.readCurrent(r.binding);
      if (!raw) throw new BrokerError('AUTHORITY_REFUSED');
      const a = validate(raw, r.binding);
      if (
        r.state !== 'active' ||
        a.runtimeIdentity !== r.runtime ||
        a.authorizationEpoch !== r.epoch ||
        a.policyRevision !== r.policy ||
        a.inventoryRevision !== r.inventory
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      r.deadline = Math.min(r.deadline, a.monotonicNow + a.utcExpiresAt - a.utcNow);
      if (now() >= r.deadline) throw new BrokerError('EXPIRED');
      if (r.state !== 'active') throw new BrokerError('CLOSED');
    } catch {
      suspend(run, true);
      throw new BrokerError('AUTHORITY_REFUSED');
    }
    return Object.freeze({
      binding: r.binding,
      runtime: r.runtime,
      epoch: r.epoch,
      policy: r.policy,
      inventory: r.inventory,
      sequence: r.sequence,
      deadline: r.deadline,
      state: r.state,
    });
  };
  const validate = (a: AuthorityObservation, b: EgressBinding) => authoritySnapshot(a, b, now());
  const checkPrepared = (run: RunHandle, receiver: PreparedRunReceiver) => {
    const r = get(run);
    try {
      if (r.state !== 'prepared' || r.receiver !== receiver) throw new BrokerError('CLOSED');
      if (now() >= r.deadline) throw new BrokerError('EXPIRED');
      const i = inventory();
      if (r.state !== 'prepared' || (!readPreparedPolicy && i.revision !== r.inventory))
        throw new BrokerError('AUTHORITY_REFUSED');
      return Object.freeze({ binding: r.binding, deadline: r.deadline });
    } catch (error) {
      suspend(run, true);
      throw error;
    }
  };
  const expirePermits = () => {
    const current = now();
    for (const [permit, p] of permits)
      if (current >= p.expires) {
        permits.delete(permit);
        ledger.release(p.charge);
      }
  };
  const read = async (b: EgressBinding, parent?: { run: RunHandle; record: RunRecord }) => {
    if (!options.ports) throw new BrokerError('UNAVAILABLE');
    const charge = ledger.reserve('permit');
    const done = ledger.pending(charge);
    const parentDone = parent ? ledger.pending(parent.record.charge) : () => {};
    const returned = () => {
      done();
      parentDone();
      ledger.release(charge);
      if (
        parent &&
        parent.record.state === 'terminal' &&
        !parent.record.renewing &&
        !parent.record.listeners.size &&
        ledger.release(parent.record.charge)
      )
        runs.delete(parent.run);
    };
    const abort = new AbortController();
    const task = Promise.resolve().then(() => options.ports!.readAuthority(b, abort.signal));
    task.then(returned, returned);
    try {
      const a = await bounded(task, limits.authorityMs);
      return validate(a, b);
    } catch {
      throw new BrokerError('AUTHORITY_REFUSED');
    } finally {
      abort.abort();
    }
  };
  const expiry = (a: AuthorityObservation, ttl: number) => {
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > limits.leaseMs)
      throw new BrokerError('PERMIT_REFUSED');
    const end = a.monotonicNow + Math.min(ttl, a.utcExpiresAt - a.utcNow);
    if (!Number.isSafeInteger(end) || end <= now()) throw new BrokerError('EXPIRED');
    return end;
  };
  return Object.freeze({
    limits,
    ledger,
    now,
    inventory,
    prepareRun(
      context: EgressBinding,
      preparation: RunPreparation,
      ttl = limits.leaseMs
    ): RunHandle {
      const b = binding(context);
      if (
        !options.ports ||
        typeof preparation.runtimeIdentity !== 'string' ||
        !preparation.runtimeIdentity.length ||
        preparation.runtimeIdentity.length > 128 ||
        ![
          preparation.authorizationEpoch,
          preparation.policyRevision,
          preparation.inventoryRevision,
        ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
        !Number.isSafeInteger(ttl) ||
        ttl <= 0 ||
        ttl > limits.leaseMs
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      const receiver = preparation.receiver;
      const ready = receiver.isAuthorityCurrent;
      if (
        typeof ready !== 'function' ||
        receiver.browserId !== b.browserId ||
        receiver.browserGeneration !== b.browserGeneration
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      const i = inventory();
      if (i.revision !== preparation.inventoryRevision) throw new BrokerError('AUTHORITY_REFUSED');
      const deadline = now() + ttl;
      if (!Number.isSafeInteger(deadline)) throw new BrokerError('EXPIRED');
      const charge = ledger.reserve('principal');
      const run = Object.freeze({ kind: 'retained-run' as const });
      ledger.bindBrowser(
        run,
        JSON.stringify([b.ownerId, b.workspaceId, b.browserId, b.browserGeneration])
      );
      runs.set(run, {
        binding: b,
        runtime: preparation.runtimeIdentity,
        epoch: preparation.authorizationEpoch,
        policy: preparation.policyRevision,
        inventory: preparation.inventoryRevision,
        receiver,
        ready: () => Reflect.apply(ready, receiver, []) === true,
        deadline,
        sequence: 0,
        state: 'prepared',
        listeners: new Set(),
        renewing: false,
        charge,
      });
      return run;
    },
    checkPrepared,
    async activatePrepared(
      run: RunHandle,
      receiver: PreparedRunReceiver,
      installPolicy?: (policy: EgressPolicyOptions) => void
    ) {
      checkPrepared(run, receiver);
      const r = get(run);
      if (r.renewing) throw new BrokerError('PERMIT_REFUSED');
      r.renewing = true;
      try {
        if (!r.ready?.()) throw new BrokerError('AUTHORITY_REFUSED');
        checkPrepared(run, receiver);
        const sealedPolicy = readPreparedPolicy?.call(options.ports, r.binding, receiver);
        if (
          readPreparedPolicy &&
          (!sealedPolicy || !installPolicy || sealedPolicy.revision !== r.policy)
        )
          throw new BrokerError('AUTHORITY_REFUSED');
        const finalInventory = inventory();
        const a = await read(r.binding, { run, record: r });
        checkPrepared(run, receiver);
        const raw = options.ports?.readCurrent(r.binding);
        if (!raw) throw new BrokerError('AUTHORITY_REFUSED');
        const current = validate(raw, r.binding);
        for (const observed of [a, current])
          if (
            observed.runtimeIdentity !== r.runtime ||
            observed.authorizationEpoch !== r.epoch ||
            observed.policyRevision !== r.policy ||
            observed.inventoryRevision !== finalInventory.revision
          )
            throw new BrokerError('AUTHORITY_REFUSED');
        const deadline = Math.min(
          r.deadline,
          expiry(a, limits.leaseMs),
          expiry(current, limits.leaseMs)
        );
        if (!r.ready?.()) throw new BrokerError('AUTHORITY_REFUSED');
        checkPrepared(run, receiver);
        if (inventory().revision !== finalInventory.revision)
          throw new BrokerError('AUTHORITY_REFUSED');
        if (sealedPolicy) installPolicy!(sealedPolicy);
        r.inventory = finalInventory.revision;
        r.deadline = deadline;
        r.state = 'active';
        check(run);
      } catch (error) {
        suspend(run, true);
        throw error;
      } finally {
        r.renewing = false;
        if (r.state === 'terminal' && !r.listeners.size && ledger.release(r.charge))
          runs.delete(run);
      }
    },
    async retainRun(context: EgressBinding, ttl = limits.leaseMs): Promise<RunHandle> {
      const b = binding(context);
      const charge = ledger.reserve('principal');
      const done = ledger.pending(charge);
      try {
        const a = await read(b);
        const i = inventory();
        if (i.revision !== a.inventoryRevision) throw new BrokerError('AUTHORITY_REFUSED');
        const run = Object.freeze({ kind: 'retained-run' as const });
        const deadline = expiry(a, ttl);
        ledger.bindBrowser(
          run,
          JSON.stringify([b.ownerId, b.workspaceId, b.browserId, b.browserGeneration])
        );
        runs.set(run, {
          binding: b,
          runtime: a.runtimeIdentity,
          epoch: a.authorizationEpoch,
          policy: a.policyRevision,
          inventory: i.revision,
          sequence: 0,
          deadline,
          state: 'active',
          listeners: new Set(),
          renewing: false,
          charge,
        });
        return run;
      } catch (error) {
        ledger.release(charge);
        throw error;
      } finally {
        done();
        if (![...runs.values()].some((r) => r.charge === charge)) ledger.release(charge);
      }
    },
    async continuation(run: RunHandle, sequence: number, ttl = limits.leaseMs): Promise<Permit> {
      expirePermits();
      check(run);
      const r = get(run);
      const current = now();
      if (
        r.state !== 'active' ||
        current >= r.deadline ||
        r.renewing ||
        [...permits.values()].some((p) => p.run === run) ||
        sequence !== r.sequence ||
        r.deadline - current > limits.renewalLeadMs
      )
        throw new BrokerError('PERMIT_REFUSED');
      r.renewing = true;
      try {
        const a = await read(r.binding);
        check(run);
        if (
          a.runtimeIdentity !== r.runtime ||
          a.authorizationEpoch !== r.epoch ||
          a.policyRevision !== r.policy ||
          a.inventoryRevision !== r.inventory ||
          sequence !== r.sequence
        )
          throw new BrokerError('PERMIT_REFUSED');
        const deadline = expiry(a, ttl),
          expires = now() + limits.permitMs;
        check(run);
        if (
          sequence !== r.sequence ||
          r.state !== 'active' ||
          a.runtimeIdentity !== r.runtime ||
          a.authorizationEpoch !== r.epoch ||
          a.policyRevision !== r.policy ||
          a.inventoryRevision !== r.inventory ||
          [...permits.values()].some((p) => p.run === run)
        )
          throw new BrokerError('PERMIT_REFUSED');
        const charge = ledger.reserve('permit');
        const permit = Object.freeze({ kind: 'broker-permit' as const });
        permits.set(permit, {
          purpose: 'continuation',
          run,
          sequence,
          epoch: r.epoch,
          policy: r.policy,
          inventory: r.inventory,
          deadline,
          expires,
          charge,
        });
        return permit;
      } finally {
        r.renewing = false;
      }
    },
    consume(run: RunHandle, sequence: number, permit: Permit) {
      check(run);
      const r = get(run);
      const p = permits.get(permit);
      const current = now();
      if (
        !p ||
        permits.get(permit) !== p ||
        runs.get(run) !== r ||
        p.purpose !== 'continuation' ||
        p.run !== run ||
        p.sequence !== sequence ||
        sequence !== r.sequence ||
        p.epoch !== r.epoch ||
        p.policy !== r.policy ||
        p.inventory !== r.inventory ||
        current >= p.expires ||
        current >= r.deadline
      )
        throw new BrokerError('PERMIT_REFUSED');
      if (r.state !== 'active') throw new BrokerError('CLOSED');
      permits.delete(permit);
      ledger.release(p.charge);
      r.deadline = p.deadline;
      r.sequence++;
    },
    async revisionPermit(run: RunHandle, sequence: number): Promise<Permit> {
      expirePermits();
      const r = get(run);
      const current = now();
      if (
        r.state !== 'suspended' ||
        current >= r.deadline ||
        r.renewing ||
        sequence !== r.sequence ||
        [...permits.values()].some((p) => p.run === run)
      )
        throw new BrokerError('PERMIT_REFUSED');
      r.renewing = true;
      try {
        const a = await read(r.binding),
          i = inventory();
        const observed = now();
        if (
          r.state !== 'suspended' ||
          observed >= r.deadline ||
          sequence !== r.sequence ||
          a.runtimeIdentity !== r.runtime ||
          a.inventoryRevision !== i.revision
        )
          throw new BrokerError('PERMIT_REFUSED');
        const deadline = Math.min(r.deadline, expiry(a, limits.leaseMs)),
          expires = now() + limits.permitMs;
        const charge = ledger.reserve('permit');
        const permit = Object.freeze({ kind: 'broker-permit' as const });
        if (
          r.state !== 'suspended' ||
          expires - limits.permitMs >= r.deadline ||
          sequence !== r.sequence ||
          [...permits.values()].some((p) => p.run === run)
        ) {
          ledger.release(charge);
          throw new BrokerError('CLOSED');
        }
        permits.set(permit, {
          purpose: 'revision',
          next: a,
          run,
          sequence,
          epoch: r.epoch,
          policy: r.policy,
          inventory: r.inventory,
          deadline,
          expires,
          charge,
        });
        return permit;
      } finally {
        r.renewing = false;
      }
    },
    consumeRevision(run: RunHandle, sequence: number, permit: Permit, revision: number) {
      const r = get(run),
        p = permits.get(permit),
        i = inventory(),
        raw = options.ports?.readCurrent(r.binding);
      if (!raw) throw new BrokerError('AUTHORITY_REFUSED');
      const a = validate(raw, r.binding);
      const nextDeadline = p?.next
        ? Math.min(p.deadline, a.monotonicNow + a.utcExpiresAt - a.utcNow)
        : 0;
      const current = now();
      if (
        permits.get(permit) !== p ||
        runs.get(run) !== r ||
        r.state !== 'suspended' ||
        current >= r.deadline ||
        current >= nextDeadline ||
        ledger.ownedCircuits(run) !== 0 ||
        !p ||
        p.purpose !== 'revision' ||
        p.run !== run ||
        sequence !== r.sequence ||
        p.sequence !== sequence ||
        p.epoch !== r.epoch ||
        p.policy !== r.policy ||
        p.inventory !== r.inventory ||
        current >= p.expires ||
        !p.next ||
        revision !== p.next.policyRevision ||
        i.revision !== p.next.inventoryRevision ||
        a.runtimeIdentity !== r.runtime ||
        a.policyRevision !== p.next.policyRevision ||
        a.authorizationEpoch !== p.next.authorizationEpoch ||
        a.inventoryRevision !== p.next.inventoryRevision
      )
        throw new BrokerError('PERMIT_REFUSED');
      if (r.state !== 'suspended') throw new BrokerError('CLOSED');
      permits.delete(permit);
      ledger.release(p.charge);
      r.policy = a.policyRevision;
      r.inventory = a.inventoryRevision;
      r.epoch = a.authorizationEpoch;
      r.deadline = nextDeadline;
      r.sequence++;
      r.state = 'active';
    },
    async current(run: RunHandle) {
      check(run);
      const r = get(run);
      const sequence = r.sequence;
      const a = await read(r.binding);
      check(run);
      if (
        sequence !== r.sequence ||
        a.runtimeIdentity !== r.runtime ||
        a.authorizationEpoch !== r.epoch ||
        a.policyRevision !== r.policy ||
        a.inventoryRevision !== r.inventory
      ) {
        suspend(run, true);
        throw new BrokerError('AUTHORITY_REFUSED');
      }
      r.deadline = Math.min(r.deadline, expiry(a, limits.leaseMs));
      check(run);
    },
    check,
    suspend,
    onInvalidation(run: RunHandle, close: (state: 'suspended' | 'terminal') => void) {
      const r = get(run);
      r.listeners.add(close);
      return () => r.listeners.delete(close);
    },
    revoke(run: RunHandle) {
      suspend(run, true);
    },
    releaseRun(run: RunHandle) {
      const r = get(run);
      if (r.listeners.size || r.renewing) return false;
      suspend(run, true);
      if (!ledger.release(r.charge)) return false;
      runs.delete(run);
      return true;
    },
    snapshot(run: RunHandle) {
      const r = get(run);
      return Object.freeze({
        binding: r.binding,
        sequence: r.sequence,
        epoch: r.epoch,
        policyRevision: r.policy,
        inventoryRevision: r.inventory,
        deadline: r.deadline,
        state: r.state,
      });
    },
  });
}
export type BrokerIssuer = ReturnType<typeof createBrokerIssuer>;
