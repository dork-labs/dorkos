import type { BrowserControllerGrant } from './grants.js';
import type { OwnedBrowserController, BrowserControllerActor } from './controller.js';
import { BrowserNavigationTransitions } from './navigation-transitions.js';
import type { Request, Response } from 'express';
import type {
  PrivateBrowserNavigationOwner,
  PrivateBrowserNavigationDispatcher,
  OwnedNavigationAuthorization,
  PrivateBrowserRetirementReceiver,
} from '@dorkos/browser/server-owner';
import { BrowserNavigateRequestSchema } from '@dorkos/shared/browser-schemas';
import type { BrowserControllerInput } from './controller-input.js';
import type { BrowserControllerHost } from './controller-host.js';
import { BrowserApiRefusal } from './service.js';

/** Exact constructor-issued navigation dispatcher with fresh server-store authority and retained originals. */
export class BrowserControllerNavigation {
  readonly owner: PrivateBrowserNavigationOwner;
  private actorAcquire?: OwnedBrowserController['captureNavigation'];
  private dispatch?: PrivateBrowserNavigationDispatcher['navigate'];
  private captureHost?: BrowserControllerHost['capture'];
  private ownerContinuation?: BrowserControllerHost['ownerContinuation'];
  private retireOwner?: BrowserControllerHost['retireOwnerContinuations'];
  private readonly lifetimes = new Map<string, Promise<void>>();
  private readonly retired = new Map<
    string,
    Readonly<{ browserId: string; browserGeneration: number }>
  >();
  private joinPublications?: BrowserControllerInput['joinPublications'];
  private closeHost?: BrowserControllerHost['closeNavigation'];
  private readonly transitions = new BrowserNavigationTransitions();
  private closed = false;
  private readonly operations = new Set<Promise<unknown>>();
  private firstFailure?: { readonly reason: unknown };
  private closing?: Promise<void>;

  private throwOriginalFailure(): void {
    if (this.firstFailure) throw this.firstFailure.reason;
  }

  constructor(input?: Pick<BrowserControllerInput, 'joinPublications'>) {
    this.joinPublications = input?.joinPublications.bind(input);
    this.owner = Object.freeze({
      ...(input
        ? {
            observeLifetime: (
              receiver: Pick<
                PrivateBrowserRetirementReceiver,
                'browserId' | 'browserGeneration' | 'observation'
              >
            ): void => {
              const browserId = receiver.browserId,
                browserGeneration = receiver.browserGeneration,
                observation = receiver.observation;
              const id = JSON.stringify([browserId, browserGeneration]);
              if (
                this.closed ||
                this.lifetimes.has(id) ||
                this.retired.has(id) ||
                this.lifetimes.size + this.retired.size >= 128
              )
                throw new BrowserApiRefusal('inaccessible');
              const settle = () => {
                this.lifetimes.delete(id);
                if (this.retireOwner) this.retireOwner(browserId, browserGeneration);
                else if (!this.closed)
                  this.retired.set(id, Object.freeze({ browserId, browserGeneration }));
              };
              const original = observation.then(settle, (reason) => {
                this.firstFailure ??= { reason };
                settle();
              });
              this.lifetimes.set(id, original);
              void original.catch((reason) => {
                this.firstFailure ??= { reason };
              });
            },
            continuation: Object.freeze({
              acquire: async (
                binding: Parameters<BrowserControllerHost['ownerContinuation']>[0]
              ) => {
                if (this.closed || !this.ownerContinuation || !this.joinPublications)
                  throw new BrowserApiRefusal('inaccessible');
                const flow = await this.ownerContinuation(binding);
                if (this.closed) {
                  await flow.close();
                  throw new BrowserApiRefusal('inaccessible');
                }
                return flow;
              },
              joinPublications: async (
                binding: Parameters<BrowserControllerInput['joinPublications']>[0]
              ) => {
                if (this.closed || !this.joinPublications)
                  throw new BrowserApiRefusal('inaccessible');
                await this.joinPublications(binding);
                if (this.closed) throw new BrowserApiRefusal('inaccessible');
              },
              observeTransition: this.transitions.observe.bind(this.transitions),
            }),
          }
        : {}),
      registerDispatcher: (original: PrivateBrowserNavigationDispatcher) => {
        if (this.closed || this.dispatch) throw new BrowserApiRefusal('inaccessible');
        const dispatch = original.navigate.bind(original);
        if (this.closed || this.dispatch) throw new BrowserApiRefusal('inaccessible');
        this.dispatch = dispatch;
      },
    });
  }

  /** Bind the genuine host once; a supplied request body never chooses this authority. */
  bindHost(
    host: Pick<
      BrowserControllerHost,
      'capture' | 'closeNavigation' | 'ownerContinuation' | 'retireOwnerContinuations'
    >
  ): void {
    if (this.closed || this.captureHost || this.operations.size)
      throw new BrowserApiRefusal('inaccessible');
    const capture = host.capture.bind(host),
      close = host.closeNavigation.bind(host),
      owner = host.ownerContinuation.bind(host),
      retire = host.retireOwnerContinuations.bind(host);
    if (this.closed || this.captureHost || this.operations.size)
      throw new BrowserApiRefusal('inaccessible');
    this.captureHost = capture;
    this.ownerContinuation = owner;
    this.retireOwner = retire;
    for (const original of this.retired.values())
      retire(original.browserId, original.browserGeneration);
    this.retired.clear();
    this.closeHost = close;
  }

  /** Bind the genuine controller before tools can use recipient navigation. */
  bindActorController(controller: Pick<OwnedBrowserController, 'captureNavigation'>): void {
    if (this.closed || this.actorAcquire || this.operations.size)
      throw new BrowserApiRefusal('unavailable');
    const original = controller.captureNavigation.bind(controller);
    if (this.closed || this.actorAcquire || this.operations.size)
      throw new BrowserApiRefusal('unavailable');
    this.actorAcquire = original;
  }

  /** Runtime actors use their original recipient grant, never a synthetic HTTP identity or owner continuation. */
  navigateForActor(
    original: Readonly<{
      refresh(): Promise<BrowserControllerActor>;
      current(): BrowserControllerActor | undefined;
      onOriginalDenial(value: BrowserApiRefusal): void;
    }>,
    value: unknown,
    controllerId: string,
    reference: BrowserControllerGrant,
    signal?: AbortSignal
  ): ReturnType<PrivateBrowserNavigationDispatcher['navigate']> {
    if (this.firstFailure) return Promise.reject(this.firstFailure.reason);
    const expected = new WeakSet<object>();
    let entered = false;
    const local = (value: BrowserApiRefusal) => {
      if (!entered) {
        expected.add(value);
        try {
          original.onOriginalDenial(value);
        } catch (reason) {
          this.firstFailure ??= { reason };
        }
      }
    };
    const refuse = () => {
      const reason = new BrowserApiRefusal('inaccessible');
      local(reason);
      return reason;
    };
    const operation = Promise.resolve().then(async () => {
      this.throwOriginalFailure();
      if (this.closed || signal?.aborted || !this.actorAcquire || !this.dispatch) throw refuse();
      const refresh = original.refresh.bind(original),
        current = original.current.bind(original);
      const command = BrowserNavigateRequestSchema.parse(value);
      const actor = await refresh();
      const read = () => {
        const live = current();
        return !this.closed &&
          !this.firstFailure &&
          !signal?.aborted &&
          live?.owner === actor.owner &&
          live.credential === actor.credential &&
          live.controllerIdentity === actor.controllerIdentity
          ? live
          : undefined;
      };
      if (!read()) throw refuse();
      const flow = this.actorAcquire(read, command.binding, controllerId, reference, {
        propagateFailures: true,
        onOriginalDenial: local,
      });
      let primary: { reason: unknown } | undefined;
      let result: Awaited<ReturnType<PrivateBrowserNavigationDispatcher['navigate']>> | undefined;
      try {
        await flow.ready;
        this.throwOriginalFailure();
        if (this.closed || signal?.aborted || !flow.authorization.isCurrent()) throw refuse();
        entered = true;
        result = await this.dispatch(command, flow.authorization, signal);
        flow.complete(result);
      } catch (reason) {
        primary = { reason };
        if (!(typeof reason === 'object' && reason !== null && expected.has(reason)))
          this.firstFailure ??= primary;
      }
      try {
        await flow.close();
      } catch (reason) {
        this.firstFailure ??= { reason };
        primary ??= { reason };
      }
      if (primary) throw primary.reason;
      if (!result) throw refuse();
      return result;
    });
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      (reason) => {
        if (!(typeof reason === 'object' && reason !== null && expected.has(reason)))
          this.firstFailure ??= { reason };
        this.operations.delete(operation);
      }
    );
    return operation;
  }

  capture(req: Request, res: Response, localTicket?: string) {
    if (this.closed || !this.captureHost || !this.dispatch)
      throw new BrowserApiRefusal('unavailable');
    const client = this.captureHost(req, res, localTicket);
    const acquire = client.navigation.bind(client),
      dispatch = this.dispatch;
    return Object.freeze({
      navigate: (
        value: unknown,
        controllerId: string,
        reference?: { grantId: string; revision: number },
        signal?: AbortSignal
      ): ReturnType<PrivateBrowserNavigationDispatcher['navigate']> => {
        if (this.closed) throw new BrowserApiRefusal('unavailable');
        const command = BrowserNavigateRequestSchema.parse(value);
        const operation = Promise.resolve().then(async () => {
          if (this.closed || signal?.aborted) throw new BrowserApiRefusal('inaccessible');
          const flow = await acquire(command.binding, controllerId, reference);
          const finish = flow.close.bind(flow);
          const complete = flow.complete.bind(flow);
          const ready = flow.ready;
          let cleanupFailed = false,
            cleanupPrimary: unknown;
          let result: Awaited<ReturnType<PrivateBrowserNavigationDispatcher['navigate']>>;
          let removeAbort: (() => void) | undefined;
          try {
            if (signal) {
              const add = signal.addEventListener,
                remove = signal.removeEventListener;
              const loss = () => {
                void finish().catch((reason) => {
                  this.firstFailure ??= { reason };
                });
              };
              removeAbort = () => Reflect.apply(remove, signal, ['abort', loss]);
              Reflect.apply(add, signal, ['abort', loss, { once: true }]);
              if (signal.aborted) loss();
            }
            await ready;
            const current = flow.authorization.isCurrent.bind(flow.authorization);
            const authorize = flow.authorization.authorize.bind(flow.authorization);
            if (!current() || this.closed || signal?.aborted)
              throw new BrowserApiRefusal('inaccessible');
            const authority: OwnedNavigationAuthorization = Object.freeze({
              isCurrent: () => {
                if (this.closed || signal?.aborted) return false;
                const admitted = current();
                return admitted && !this.closed && !signal?.aborted;
              },
              authorize: async (...args: Parameters<OwnedNavigationAuthorization['authorize']>) => {
                if (this.closed || signal?.aborted) return 'refused';
                const result = await authorize(...args);
                return this.closed || signal?.aborted ? 'refused' : result;
              },
            });
            result = await dispatch(command, authority, signal);
            complete(result);
          } catch (reason) {
            if (!(reason instanceof BrowserApiRefusal)) this.firstFailure ??= { reason };
            throw reason;
          } finally {
            for (const cleanup of [
              () => finish(),
              () => {
                removeAbort?.();
              },
            ]) {
              try {
                await cleanup();
              } catch (reason) {
                this.firstFailure ??= { reason };
                if (!cleanupFailed) {
                  cleanupFailed = true;
                  cleanupPrimary = reason;
                }
              }
            }
          }
          if (cleanupFailed) throw cleanupPrimary;
          return result;
        });
        this.operations.add(operation);
        void operation.then(
          () => this.operations.delete(operation),
          (reason) => {
            if (!(reason instanceof BrowserApiRefusal)) this.firstFailure ??= { reason };
            this.operations.delete(operation);
          }
        );
        return operation;
      },
    });
  }

  /** Completion join is not authority; the session must freshly authenticate/read its engine afterward. */
  joinTransitions(browserId: string, browserGeneration: number): Promise<void> {
    return this.transitions.join(browserId, browserGeneration);
  }

  /** Fence synchronously, then independently join the original dispatcher and host cleanup. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const host = Promise.resolve().then(() => this.closeHost?.());
    this.closing = Promise.allSettled([
      ...this.operations,
      ...this.lifetimes.values(),
      this.transitions.close(),
      host,
    ]).then((results) => {
      const failed = results
        .slice(0, -1)
        .find(
          (result) => result.status === 'rejected' && !(result.reason instanceof BrowserApiRefusal)
        );
      const originalHost = results.at(-1);
      this.throwOriginalFailure();
      if (failed?.status === 'rejected') throw failed.reason;
      if (originalHost?.status === 'rejected') throw originalHost.reason;
    });
    return this.closing;
  }
}
