import type { Request, Response } from 'express';
import type {
  PrivateBrowserInputOwner,
  PrivateBrowserInputDispatcher,
  OwnedInputAuthorization,
} from '@dorkos/browser/server-owner';
import { type BrowserBinding, BrowserInputRequestSchema } from '@dorkos/shared/browser-schemas';
import type { BrowserControllerHost } from './controller-host.js';
import { BrowserApiRefusal } from './service.js';

/** Private host dispatch bank; only the original engine constructor can supply this input path. */
export class BrowserControllerInput {
  readonly owner: PrivateBrowserInputOwner;
  private dispatch?: PrivateBrowserInputDispatcher['input'];
  private captureHost?: BrowserControllerHost['capture'];
  private closed = false;
  private readonly operations = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private readonly publications = new Map<Promise<void>, BrowserBinding>();
  private readonly publicationFailures = new Map<string, { readonly reason: unknown }>();

  constructor() {
    this.owner = Object.freeze({
      registerDispatcher: (original: PrivateBrowserInputDispatcher) => {
        if (this.closed || this.dispatch) throw new BrowserApiRefusal('inaccessible');
        const input = original.input.bind(original);
        if (this.closed || this.dispatch) throw new BrowserApiRefusal('inaccessible');
        this.dispatch = input;
      },
    });
  }

  bindHost(host: Pick<BrowserControllerHost, 'capture'>): void {
    if (this.closed || this.captureHost || this.operations.size)
      throw new BrowserApiRefusal('inaccessible');
    this.captureHost = host.capture.bind(host);
  }

  capture(
    req: Request,
    res: Response,
    localTicket?: string,
    publication?: () => Promise<void>
  ): Readonly<{
    input(
      value: unknown,
      controllerId: string,
      reference?: { grantId: string; revision: number },
      signal?: AbortSignal
    ): ReturnType<PrivateBrowserInputDispatcher['input']>;
  }> {
    if (this.closed || !this.captureHost || !this.dispatch)
      throw new BrowserApiRefusal('unavailable');
    if (publication !== undefined && typeof publication !== 'function')
      throw new BrowserApiRefusal('inaccessible');
    const client = this.captureHost(req, res, localTicket);
    return this.captureAuthorization(client.authorization.bind(client), publication);
  }

  /** Constructor-private authenticated admission; runtime callers never synthesize HTTP credentials. */
  captureAuthorization(
    authorize: (
      binding: BrowserBinding,
      controllerId: string,
      reference?: { grantId: string; revision: number }
    ) => Promise<OwnedInputAuthorization>,
    originalPublication?: () => Promise<void>
  ): Readonly<{
    input(
      value: unknown,
      controllerId: string,
      reference?: { grantId: string; revision: number },
      signal?: AbortSignal
    ): ReturnType<PrivateBrowserInputDispatcher['input']>;
  }> {
    if (this.closed || !this.dispatch || typeof authorize !== 'function')
      throw new BrowserApiRefusal('unavailable');
    const dispatch = this.dispatch;
    return Object.freeze({
      input: (
        value: unknown,
        controllerId: string,
        reference?: { grantId: string; revision: number },
        signal?: AbortSignal
      ) => {
        if (this.closed) throw new BrowserApiRefusal('unavailable');
        const command = BrowserInputRequestSchema.parse(value);
        const lifetime = JSON.stringify([
          command.binding.browserId,
          command.binding.browserGeneration,
          command.binding.tabId,
        ]);
        const prior = this.publicationFailures.get(lifetime);
        if (prior) throw prior.reason;
        if (this.publicationFailures.size >= 128) throw new BrowserApiRefusal('unavailable');
        // Actual HTTP publication is completion custody, never navigation permission.
        const wire = originalPublication?.();
        const operation = Promise.resolve().then(async () => {
          if (this.closed) throw new BrowserApiRefusal('unavailable');
          const authority = await authorize(command.binding, controllerId, reference);
          const current = authority.isCurrent.bind(authority),
            step = authority.authorize.bind(authority);
          if (!current() || this.closed) throw new BrowserApiRefusal('inaccessible');
          if (wire) {
            this.publications.set(wire, Object.freeze({ ...command.binding }));
            void wire.then(
              () => this.publications.delete(wire),
              (reason) => {
                if (!this.publicationFailures.has(lifetime))
                  this.publicationFailures.set(lifetime, { reason });
                this.publications.delete(wire);
              }
            );
          }
          const original: OwnedInputAuthorization = Object.freeze({
            isCurrent: () => {
              if (this.closed) return false;
              const observed = current();
              return observed && !this.closed;
            },
            authorize: async (...args: Parameters<OwnedInputAuthorization['authorize']>) => {
              if (this.closed) return 'refused';
              const result = await step(...args);
              return this.closed ? 'refused' : result;
            },
          });
          return dispatch(command, original, signal);
        });
        // Retain before any awaited auth or original engine producer; close never substitutes completion.
        this.operations.add(operation);
        void operation.then(
          () => this.operations.delete(operation),
          () => this.operations.delete(operation)
        );
        return operation;
      },
    });
  }

  /** Join only original responses for this immutable browser/tab lifetime.
   * A native Route pauses commit; it does not substitute for the actual HTTP finish.
   */
  async joinPublications(binding: BrowserBinding): Promise<void> {
    const lifetime = JSON.stringify([binding.browserId, binding.browserGeneration, binding.tabId]);
    const first = this.publicationFailures.get(lifetime);
    const originals = [...this.publications]
      .filter(
        ([, original]) =>
          original.browserId === binding.browserId &&
          original.browserGeneration === binding.browserGeneration &&
          original.tabId === binding.tabId
      )
      .map(([original]) => original);
    const results = await Promise.allSettled(originals);
    const originalFailure = first ?? this.publicationFailures.get(lifetime);
    if (originalFailure) throw originalFailure.reason;
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (this.closed) throw new BrowserApiRefusal('unavailable');
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.allSettled([...this.operations, ...this.publications.keys()]).then(
      (results) => {
        const originalFailure = this.publicationFailures.values().next().value;
        if (originalFailure) throw originalFailure.reason;
        const first = results.find((result) => result.status === 'rejected');
        if (first?.status === 'rejected') throw first.reason;
      }
    );
    return this.closing;
  }
}
