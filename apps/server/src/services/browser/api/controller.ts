import { randomBytes } from 'node:crypto';
import type {
  BrowserLifecycleEngine,
  OwnedInputAuthorization,
  OwnedNavigationAuthorization,
} from '@dorkos/browser/server-owner';
import {
  BrowserBindingSchema,
  BrowserControlSchema,
  type BrowserBinding,
  type BrowserControl,
} from '@dorkos/shared/browser-schemas';
import type { BrowserRegistry } from '../registry/registry.js';
import type { BrowserViewHost } from '../stream/view-host.js';
import type { BrowserControllerGrant, OwnedBrowserGrants } from './grants.js';
import { BrowserApiRefusal, type BrowserApiActor } from './service.js';

/** Server-owned controller identity; never supplied by a request body or client header. */
export type BrowserControllerActor = BrowserApiActor & {
  readonly controllerIdentity: object;
};

/** Private original navigation permission, distinct from the deliberately fenced old Seat. */
export interface BrowserControllerNavigationFlow {
  readonly authorization: OwnedNavigationAuthorization;
  readonly ready: Promise<void>;
  complete(binding: BrowserBinding): void;
  close(): Promise<void>;
}

type ResetResult = Awaited<ReturnType<BrowserLifecycleEngine['resetInput']>>;
type Seat = {
  owner: string;
  resourceOwner: string;
  cancel?: (error: unknown) => void;
  controllerIdentity: object;
  grantIdentity?: object;
  state: BrowserControl;
  promise: Promise<BrowserControl>;
  failed: boolean;
  operation?: Promise<ResetResult>;
};
const same = (a: BrowserBinding, b: BrowserBinding) =>
  Object.keys(a).every((key) => a[key as keyof BrowserBinding] === b[key as keyof BrowserBinding]);
const key = (binding: BrowserBinding) =>
  JSON.stringify([binding.browserId, binding.browserGeneration, binding.tabId]);

/** Private controller: exact owner/grant admission stops immediately, then the original engine drains/reset publishes. */
export class OwnedBrowserController {
  private readonly seats = new Map<string, Seat>();
  private readonly lossResets = new WeakMap<Seat, Promise<void>>();
  private readonly navigationFlows = new Map<string, object>();
  private navigationClosed = false;
  private readonly navigationCleanup = new Set<Promise<void>>();
  private navigationCleanupFailure?: { readonly reason: unknown };
  private readonly navigationLoss = new WeakMap<object, () => void>();
  private fenceNavigationViews?: BrowserViewHost['bindingLost'];
  private readonly resets = new Set<Promise<ResetResult>>();
  private readonly seatResets = new WeakMap<Seat, Set<Promise<ResetResult>>>();
  private readonly readInstance: BrowserRegistry['instance'];
  private readonly stopInstance: BrowserRegistry['stop'];
  private readonly readTabs: BrowserLifecycleEngine['listTabs'];
  private readonly reset: BrowserLifecycleEngine['resetInput'];
  private readonly admitGrant?: OwnedBrowserGrants['admitController'];

  /** Capture original registry/engine methods; the default-off setting is server authority. */
  constructor(
    registry: Pick<BrowserRegistry, 'instance' | 'stop'>,
    engine: Pick<BrowserLifecycleEngine, 'listTabs' | 'resetInput'>,
    private readonly enabled: () => boolean = () => false,
    grants?: Pick<OwnedBrowserGrants, 'admitController'>
  ) {
    this.readInstance = registry.instance.bind(registry);
    this.stopInstance = registry.stop.bind(registry);
    this.readTabs = engine.listTabs.bind(engine);
    this.reset = engine.resetInput.bind(engine);
    this.admitGrant = grants?.admitController.bind(grants);
  }

  private actor(
    read: () => BrowserControllerActor | undefined,
    denial: (reason: BrowserApiRefusal['reason']) => BrowserApiRefusal = (reason) =>
      new BrowserApiRefusal(reason)
  ) {
    if (!this.enabled()) throw denial('unavailable');
    const actor = read();
    if (!actor) throw denial('unauthenticated');
    const owner = actor.owner,
      credential = actor.credential,
      controllerIdentity = actor.controllerIdentity;
    if (!controllerIdentity) throw denial('unauthenticated');
    return {
      owner,
      controllerIdentity,
      check: () => {
        if (!this.enabled()) throw denial('unavailable');
        const current = read();
        if (
          !current ||
          current.owner !== owner ||
          current.credential !== credential ||
          current.controllerIdentity !== controllerIdentity
        )
          throw denial('unauthenticated');
      },
    };
  }

  private owned(
    owner: string,
    binding: BrowserBinding,
    grant?: BrowserControllerGrant,
    onOriginalDenial?: (value: BrowserApiRefusal) => void
  ): object | undefined {
    const denial = (reason: BrowserApiRefusal['reason']) => {
      const value = new BrowserApiRefusal(reason);
      onOriginalDenial?.(value);
      return value;
    };
    const admitted = grant ? this.admitGrant?.(grant, owner, binding, onOriginalDenial) : undefined;
    if (grant && !admitted) throw denial('inaccessible');
    const resourceOwner = admitted?.owner ?? owner;
    if (
      this.readInstance(resourceOwner, binding.browserId, binding.browserGeneration).status !==
      'running'
    )
      throw denial('inaccessible');
    const final = grant ? this.admitGrant!(grant, owner, binding, onOriginalDenial) : undefined;
    if (admitted?.identity !== final?.identity) throw denial('inaccessible');
    return final?.identity;
  }
  private current(
    owner: string,
    binding: BrowserBinding,
    grant?: BrowserControllerGrant,
    onOriginalDenial?: (value: BrowserApiRefusal) => void
  ): void {
    const denial = (reason: BrowserApiRefusal['reason']) => {
      const value = new BrowserApiRefusal(reason);
      onOriginalDenial?.(value);
      return value;
    };
    this.owned(owner, binding, grant, onOriginalDenial);
    if (
      !this.readTabs(binding.browserId, binding.browserGeneration).some((tab) => same(tab, binding))
    )
      throw denial('inaccessible');
    this.owned(owner, binding, grant, onOriginalDenial);
  }

  /** Bind the actual original viewer-loss bank once, before any navigation factory enters. */
  bindNavigationViews(host: Pick<BrowserViewHost, 'bindingLost'>): void {
    if (this.navigationClosed || this.fenceNavigationViews || this.navigationFlows.size)
      throw new BrowserApiRefusal('inaccessible');
    const fence = host.bindingLost.bind(host);
    if (this.navigationClosed || this.fenceNavigationViews || this.navigationFlows.size)
      throw new BrowserApiRefusal('inaccessible');
    this.fenceNavigationViews = fence;
  }

  /** Natural navigation is a fresh human owner operation, never borrowed input Work.
   * Only the current ungranted controller of an owned original is eligible.
   */
  captureOwnerNavigation(
    readActor: () => BrowserControllerActor | undefined,
    value: BrowserBinding
  ): BrowserControllerNavigationFlow {
    const binding = Object.freeze(BrowserBindingSchema.parse(value));
    const actor = this.actor(readActor),
      id = key(binding),
      seat = this.seats.get(id);
    const instance = this.readInstance(actor.owner, binding.browserId, binding.browserGeneration);
    this.current(actor.owner, binding);
    actor.check();
    if (
      instance.status !== 'running' ||
      !seat ||
      seat.resourceOwner !== actor.owner ||
      seat.owner !== actor.owner ||
      seat.grantIdentity !== undefined ||
      seat.controllerIdentity !== actor.controllerIdentity ||
      seat.failed ||
      seat.state.status !== 'ready' ||
      !seat.state.controllerId ||
      !same(seat.state.binding, binding) ||
      this.seats.get(id) !== seat
    )
      throw new BrowserApiRefusal('inaccessible');
    return this.captureNavigation(readActor, binding, seat.state.controllerId);
  }

  /** Capture one genuine original actor/grant flow before fencing its old controller.
   * This permits only the exact engine navigation transition, never arbitrary successor input.
   */
  captureNavigation(
    readActor: () => BrowserControllerActor | undefined,
    value: BrowserBinding,
    controllerId: string,
    grant?: BrowserControllerGrant,
    strict?: Readonly<{
      propagateFailures: true;
      onOriginalDenial(value: BrowserApiRefusal): void;
    }>
  ): BrowserControllerNavigationFlow {
    const propagateFailures = strict?.propagateFailures === true;
    const onDenial = strict?.onOriginalDenial.bind(strict);
    const denial = (reason: BrowserApiRefusal['reason']) => {
      const original = new BrowserApiRefusal(reason);
      onDenial?.(original);
      return original;
    };
    if (this.navigationClosed || !this.fenceNavigationViews) throw denial('unavailable');
    const binding = Object.freeze(BrowserBindingSchema.parse(value));
    const input = this.authorization(readActor, binding, controllerId, grant, strict);
    if (!input.isCurrent()) throw denial('inaccessible');
    const actor = this.actor(readActor, denial),
      id = key(binding),
      seat = this.seats.get(id);
    const identity = this.owned(actor.owner, binding, grant, onDenial);
    this.current(actor.owner, binding, grant, onDenial);
    const end = performance.now() + 5000;
    actor.check();
    if (
      !Number.isFinite(end) ||
      !seat ||
      seat.failed ||
      seat.state.status !== 'ready' ||
      seat.state.controllerId !== controllerId ||
      seat.controllerIdentity !== actor.controllerIdentity ||
      seat.grantIdentity !== identity ||
      this.seats.get(id) !== seat ||
      this.navigationFlows.has(id) ||
      !same(seat.state.binding, binding)
    )
      throw denial('inaccessible');
    const token = Object.freeze({});
    let closed = false,
      completed = false;
    let closing: Promise<void> | undefined;
    const check = (observed?: BrowserBinding): boolean => {
      try {
        if (
          this.navigationClosed ||
          closed ||
          this.navigationFlows.get(id) !== token ||
          this.seats.get(id) !== seat
        )
          return false;
        const tabs = this.readTabs(binding.browserId, binding.browserGeneration);
        const current = tabs.find((tab) => tab.tabId === binding.tabId);
        if (
          !current ||
          current.viewportVersion !== binding.viewportVersion ||
          ![binding.epoch, binding.epoch + 1].includes(current.epoch) ||
          current.inputGeneration - binding.inputGeneration !== current.epoch - binding.epoch ||
          ![binding.navigationGeneration, binding.navigationGeneration + 1].includes(
            current.navigationGeneration
          ) ||
          (current.navigationGeneration !== binding.navigationGeneration &&
            current.epoch === binding.epoch) ||
          (observed && !same(current, observed))
        )
          return false;
        const finalIdentity = this.owned(actor.owner, current, grant, onDenial);
        const now = performance.now();
        actor.check();
        return (
          !this.navigationClosed &&
          !closed &&
          this.navigationFlows.get(id) === token &&
          this.seats.get(id) === seat &&
          seat.failed &&
          seat.controllerIdentity === actor.controllerIdentity &&
          seat.grantIdentity === identity &&
          finalIdentity === identity &&
          Number.isFinite(now) &&
          now < end
        );
      } catch (value) {
        if (propagateFailures) throw value;
        return false;
      }
    };
    const close = (): Promise<void> => {
      if (closing) return closing;
      closed = true;
      if (completed) {
        if (this.navigationFlows.get(id) === token) this.navigationFlows.delete(id);
        if (this.seats.get(id) === seat) this.seats.delete(id);
        closing = Promise.resolve();
        return closing;
      }
      let resolve!: () => void, reject!: (reason: unknown) => void;
      closing = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // Reserve the original close before reset loss callbacks can reenter it.
      const reset = this.resetSeats((candidate) => candidate === seat);
      const cleanup = (async () => {
        let failed = false,
          primary: unknown;
        try {
          await reset;
        } catch (reason) {
          failed = true;
          primary = reason;
        }
        const results = await Promise.allSettled([...(this.seatResets.get(seat) ?? [])]);
        if (failed) throw primary;
        const negative = results.find((result) => result.status === 'rejected');
        if (negative?.status === 'rejected') throw negative.reason;
      })();
      this.navigationCleanup.add(cleanup);
      void cleanup.then(
        () => {
          this.navigationCleanup.delete(cleanup);
          if (this.navigationFlows.get(id) === token) this.navigationFlows.delete(id);
          resolve();
        },
        (reason) => {
          this.navigationCleanupFailure ??= { reason };
          this.navigationCleanup.delete(cleanup);
          reject(reason);
        }
      );
      // A synchronous refusal can leave no recipient of this original close yet.
      void closing.catch(() => {});
      return closing;
    };
    // Synchronous old input admission fence; engine owns actual reset and native custody.
    this.navigationFlows.set(id, token);
    this.navigationLoss.set(token, () => {
      void close();
    });
    seat.failed = true;
    let ready: Promise<void>;
    try {
      ready = this.fenceNavigationViews(binding);
      actor.check();
      if (!check()) throw denial('inaccessible');
    } catch (primary) {
      // Viewer-listener failure cannot suppress original held-input cleanup.
      void close();
      throw primary;
    }
    const authorization: OwnedNavigationAuthorization = Object.freeze({
      isCurrent: () => check(),
      authorize: async (
        current: BrowserBinding,
        url: string,
        signal: AbortSignal
      ): Promise<'allowed' | 'refused' | 'unknown'> => {
        if (signal.aborted) return 'refused';
        const target = new URL(url);
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
          return 'refused';
        return check(current) && !signal.aborted ? 'allowed' : 'refused';
      },
    });
    return Object.freeze({
      authorization,
      ready,
      complete: (value: BrowserBinding) => {
        const observed = Object.freeze(BrowserBindingSchema.parse(value));
        if (
          !check(observed) ||
          observed.epoch !== binding.epoch + 1 ||
          observed.inputGeneration !== binding.inputGeneration + 1 ||
          observed.navigationGeneration !== binding.navigationGeneration + 1
        )
          throw denial('inaccessible');
        completed = true;
      },
      close,
    });
  }

  /** Fence every retained flow and join original cleanup, preserving even a falsy failure. */
  async closeNavigation(): Promise<void> {
    this.navigationClosed = true;
    for (const token of this.navigationFlows.values()) this.navigationLoss.get(token)?.();
    await Promise.allSettled([...this.navigationCleanup]);
    if (this.navigationCleanupFailure) throw this.navigationCleanupFailure.reason;
  }

  private retainReset(seat: Seat, operation: Promise<ResetResult>): void {
    this.resets.add(operation);
    const originals = this.seatResets.get(seat) ?? new Set<Promise<ResetResult>>();
    this.seatResets.set(seat, originals);
    originals.add(operation);
    const settled = () => {
      originals.delete(operation);
    };
    void operation.then(settled, settled);
  }

  /** Actual retained producer count, including a reset held beyond its caller deadline. */
  pendingResets(): number {
    return this.resets.size;
  }

  /** Authenticated controller takeover fences prior work before the actual two-second reset barrier. */
  takeover(
    readActor: () => BrowserControllerActor | undefined,
    value: BrowserBinding,
    grant?: BrowserControllerGrant
  ): Promise<BrowserControl> {
    const binding = Object.freeze(BrowserBindingSchema.parse(value)),
      actor = this.actor(readActor),
      id = key(binding);
    const grantIdentity = this.owned(actor.owner, binding, grant);
    const resourceOwner = grant ? this.admitGrant!(grant, actor.owner, binding).owner : actor.owner;
    actor.check();
    const prior = this.seats.get(id);
    if (
      prior?.state.status === 'barrier' &&
      prior.owner === actor.owner &&
      prior.controllerIdentity === actor.controllerIdentity &&
      prior.grantIdentity === grantIdentity &&
      same(prior.state.binding, binding)
    )
      return prior.promise;
    if (prior?.state.status === 'barrier' || prior?.failed)
      throw new BrowserApiRefusal('inaccessible');
    this.current(actor.owner, binding, grant);
    actor.check();
    let resolve!: (state: BrowserControl) => void, reject!: (error: unknown) => void;
    const promise = new Promise<BrowserControl>((accept, refuse) => {
      resolve = accept;
      reject = refuse;
    });
    const seat: Seat = {
      owner: actor.owner,
      resourceOwner,
      controllerIdentity: actor.controllerIdentity,
      grantIdentity,
      state: { binding, controllerId: null, status: 'barrier' },
      promise,
      failed: false,
    };
    // Publish before reset or any engine callback: previous authorizations now see a different Seat.
    this.seats.set(id, seat);
    const fail = (error: unknown) => {
      if (seat.failed) return;
      seat.failed = true;
      seat.state = {
        binding: seat.state.binding,
        controllerId: null,
        status: 'stopped',
      };
      clearTimeout(timer);
      try {
        this.stopInstance(resourceOwner, binding.browserId, binding.browserGeneration);
      } catch {
        /* Preserve the original barrier failure. */
      }
      reject(error);
    };
    seat.cancel = (error) => {
      seat.failed = true;
      seat.state = {
        binding: seat.state.binding,
        controllerId: null,
        status: 'stopped',
      };
      clearTimeout(timer);
      reject(error);
    };
    const deadline = Date.now() + 2000;
    const timer = setTimeout(() => fail(new BrowserApiRefusal('inaccessible')), 2000);
    try {
      actor.check();
      const operation = this.reset(binding);
      seat.operation = operation;
      this.retainReset(seat, operation);
      void operation.then(
        (result) => {
          this.resets.delete(operation);
          if (seat.failed || this.seats.get(id) !== seat) return;
          try {
            if (Date.now() >= deadline) throw new BrowserApiRefusal('inaccessible');
            const next = BrowserBindingSchema.parse(result.binding);
            if (
              result.status !== 'ready' ||
              next.browserId !== binding.browserId ||
              next.browserGeneration !== binding.browserGeneration ||
              next.tabId !== binding.tabId ||
              next.navigationGeneration !== binding.navigationGeneration ||
              next.viewportVersion !== binding.viewportVersion ||
              next.epoch !== binding.epoch + 1 ||
              next.inputGeneration !== binding.inputGeneration + 1
            )
              throw new BrowserApiRefusal('inaccessible');
            this.current(actor.owner, next, grant);
            actor.check();
            if (seat.failed || this.seats.get(id) !== seat)
              throw new BrowserApiRefusal('inaccessible');
            seat.state = BrowserControlSchema.parse({
              binding: next,
              controllerId: randomBytes(16).toString('base64url'),
              status: 'ready',
            });
            clearTimeout(timer);
            resolve(BrowserControlSchema.parse(seat.state));
          } catch (error) {
            fail(error);
          }
        },
        (error) => {
          this.resets.delete(operation);
          fail(error);
        }
      );
    } catch (error) {
      fail(error);
    }
    return promise;
  }

  /** Fence every exact grant Seat before retaining its original reset; success publishes no new ticket. */
  revokeGrant(identity: object): Promise<void> {
    return this.resetSeats((seat) => seat.grantIdentity === identity);
  }

  /** Exact server-issued authenticated controller identity loss clears held input on its original Seats. */
  revokeController(identity: object): Promise<void> {
    return this.resetSeats((seat) => seat.controllerIdentity === identity);
  }

  private resetSeats(matches: (seat: Seat) => boolean): Promise<void> {
    const entries = [...this.seats.values()].filter(
      (seat) =>
        matches(seat) &&
        (this.lossResets.has(seat) ||
          !seat.failed ||
          this.navigationFlows.has(key(seat.state.binding)))
    );
    const originals: {
      seat: Seat;
      binding: BrowserBinding;
      barrier: boolean;
      resolve(): void;
      reject(value: unknown): void;
      first?: { value: unknown };
    }[] = [];
    const operations = entries.map((seat) => {
      const existing = this.lossResets.get(seat);
      if (existing) return existing;
      let resolve!: () => void, reject!: (value: unknown) => void;
      const original = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // Publish the exact Seat loss before navigation close can reenter resetSeats.
      this.lossResets.set(seat, original);
      void original.catch(() => {});
      originals.push({
        seat,
        binding: seat.state.binding,
        barrier: seat.state.status === 'barrier',
        resolve,
        reject,
      });
      return original;
    });
    for (const original of originals) {
      const flow = this.navigationFlows.get(key(original.binding));
      try {
        if (flow) this.navigationLoss.get(flow)?.();
      } catch (value) {
        original.first ??= { value };
      }
      try {
        original.seat.cancel!(new BrowserApiRefusal('inaccessible'));
      } catch (value) {
        original.first ??= { value };
      }
    }
    const deadline = Date.now() + 2000;
    for (const original of originals) {
      const { seat, binding: originalBinding, barrier } = original;
      const work = (async () => {
        let binding = originalBinding;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // A reentrant callback can revoke before takeover has assigned the original reset promise.
          await Promise.resolve();
          if (Date.now() >= deadline) throw new BrowserApiRefusal('inaccessible');
          if (!barrier) {
            // The engine may have cleanly advanced input protocol after aborting original Work.
            // Loss cleanup follows only this Seat's immutable original browser/tab lifetime.
            const observed = this.readTabs(
              originalBinding.browserId,
              originalBinding.browserGeneration
            ).find(
              (tab) =>
                tab.browserId === originalBinding.browserId &&
                tab.browserGeneration === originalBinding.browserGeneration &&
                tab.tabId === originalBinding.tabId
            );
            if (!observed) throw new BrowserApiRefusal('inaccessible');
            binding = BrowserBindingSchema.parse(observed);
            this.current(seat.resourceOwner, binding);
            if (Date.now() >= deadline) throw new BrowserApiRefusal('inaccessible');
          }
          const operation = barrier ? seat.operation : this.reset(binding);
          if (!operation) throw new BrowserApiRefusal('inaccessible');
          this.retainReset(seat, operation);
          void operation.then(
            () => this.resets.delete(operation),
            () => this.resets.delete(operation)
          );
          const result = await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new BrowserApiRefusal('inaccessible')),
                Math.max(1, deadline - Date.now())
              );
            }),
          ]);
          if (Date.now() >= deadline) throw new BrowserApiRefusal('inaccessible');
          const next = BrowserBindingSchema.parse(result.binding);
          // Loss cleanup may join an engine reset whose binding was already published.
          // The genuine original engine promise owns its cleanup; this path never issues a ticket.
          const protocol =
            (next.epoch === binding.epoch && next.inputGeneration === binding.inputGeneration) ||
            (next.epoch === binding.epoch + 1 &&
              next.inputGeneration === binding.inputGeneration + 1);
          if (
            result.status !== 'ready' ||
            next.browserId !== binding.browserId ||
            next.browserGeneration !== binding.browserGeneration ||
            next.tabId !== binding.tabId ||
            next.navigationGeneration !== binding.navigationGeneration ||
            next.viewportVersion !== binding.viewportVersion ||
            !protocol
          )
            throw new BrowserApiRefusal('inaccessible');
          this.current(seat.resourceOwner, next);
          if (this.seats.get(key(binding)) === seat) this.seats.delete(key(binding));
        } catch (primary) {
          try {
            this.stopInstance(seat.resourceOwner, binding.browserId, binding.browserGeneration);
          } catch {
            /* Preserve the original reset failure, including undefined. */
          }
          throw primary;
        } finally {
          if (timer) clearTimeout(timer);
        }
      })();
      void work.then(
        () => {
          if (original.first) original.reject(original.first.value);
          else original.resolve();
        },
        (value) => original.reject(original.first ? original.first.value : value)
      );
    }
    // Every original closure enters independently, even if an earlier reset fails.
    return Promise.allSettled(operations).then((results) => {
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
  }

  /** A private engine-issued Work can use this exact seat; DTO copies never become controllers. */
  authorization(
    readActor: () => BrowserControllerActor | undefined,
    bindingValue: BrowserBinding,
    controllerId: string,
    grant?: BrowserControllerGrant,
    strict?: Readonly<{
      propagateFailures: true;
      onOriginalDenial(value: BrowserApiRefusal): void;
    }>
  ): OwnedInputAuthorization {
    const propagateFailures = strict?.propagateFailures === true;
    const onDenial = strict?.onOriginalDenial.bind(strict);
    const denial = (reason: BrowserApiRefusal['reason']) => {
      const value = new BrowserApiRefusal(reason);
      onDenial?.(value);
      return value;
    };
    const binding = Object.freeze(BrowserBindingSchema.parse(bindingValue)),
      actor = this.actor(readActor, denial),
      id = key(binding),
      seat = this.seats.get(id);
    const check = (): boolean => {
      try {
        actor.check();
        if (
          !seat ||
          seat.owner !== actor.owner ||
          seat.controllerIdentity !== actor.controllerIdentity ||
          seat.grantIdentity !== this.owned(actor.owner, binding, grant, onDenial) ||
          seat.state.controllerId !== controllerId ||
          seat.state.status !== 'ready' ||
          this.seats.get(id) !== seat ||
          !same(seat.state.binding, binding)
        )
          return false;
        this.current(actor.owner, binding, grant, onDenial);
        const finalGrantIdentity = this.owned(actor.owner, binding, grant, onDenial);
        actor.check();
        return (
          !seat.failed &&
          seat.state.status === 'ready' &&
          seat.state.controllerId === controllerId &&
          seat.controllerIdentity === actor.controllerIdentity &&
          seat.grantIdentity === finalGrantIdentity &&
          same(seat.state.binding, binding) &&
          this.seats.get(id) === seat
        );
      } catch (value) {
        if (propagateFailures) throw value;
        return false;
      }
    };
    if (!check()) throw denial('inaccessible');
    const authorization: OwnedInputAuthorization = {
      isCurrent: check,
      authorize: async (current: BrowserBinding, _step, signal) =>
        !signal.aborted && same(current, binding) && check() ? 'allowed' : 'refused',
    };
    return Object.freeze(authorization);
  }
}
