import type { OwnedBrowserController } from '../api/controller.js';
import type { BrowserControllerIdentities } from '../api/controller-auth.js';
import type { OwnedBrowserGrants } from '../api/grants.js';
import type { BrowserGrantScopeLoss } from '../api/grant-scope.js';
import type { BrowserViewHost } from './view-host.js';

/** Single-bind reset receiver forwards exact original loss identities to viewers first. */
export class BrowserViewLossFanOut {
  private readonly identityLost: BrowserViewHost['identityLost'];
  private readonly grantLost: BrowserViewHost['grantLost'];
  private readonly resetIdentity: OwnedBrowserController['revokeController'];
  private readonly resetGrant: OwnedBrowserController['revokeGrant'];
  private readonly work = new Set<Promise<void>>();
  private closing?: Promise<void>;
  private preparing?: Promise<void>;
  private readonly resetClosures: Promise<unknown>[] = [];
  private failed = false;
  private first: unknown;
  private readonly closeHost: BrowserViewHost['close'];
  private readonly closeScope: BrowserGrantScopeLoss['close'];
  private readonly closeGrants: OwnedBrowserGrants['closeExpiry'];
  private readonly closeIdentities: BrowserControllerIdentities['close'];

  constructor(
    host: Pick<BrowserViewHost, 'identityLost' | 'grantLost' | 'close'>,
    controller: Pick<OwnedBrowserController, 'revokeController' | 'revokeGrant'>,
    scope: Pick<BrowserGrantScopeLoss, 'close'>,
    grants: Pick<OwnedBrowserGrants, 'closeExpiry'>,
    identities: Pick<BrowserControllerIdentities, 'close'>
  ) {
    this.closeHost = host.close.bind(host);
    this.closeScope = scope.close.bind(scope);
    this.closeGrants = grants.closeExpiry.bind(grants);
    this.closeIdentities = identities.close.bind(identities);
    this.identityLost = host.identityLost.bind(host);
    this.grantLost = host.grantLost.bind(host);
    this.resetIdentity = controller.revokeController.bind(controller);
    this.resetGrant = controller.revokeGrant.bind(controller);
  }

  private failure(error: unknown): void {
    if (!this.failed) {
      this.failed = true;
      this.first = error;
    }
  }

  private loss(
    identity: object,
    fence: (identity: object) => void,
    reset: (identity: object) => Promise<void>
  ): Promise<void> {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const retained = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Publish retention before a listener or original reset can reenter.
    this.work.add(retained);
    void retained.then(
      () => this.work.delete(retained),
      () => this.work.delete(retained)
    );
    let failed = false,
      first: unknown;
    const failure = (error: unknown) => {
      this.failure(error);
      if (!failed) {
        failed = true;
        first = error;
      }
    };
    try {
      fence(identity);
    } catch (error) {
      failure(error);
    }
    let original: Promise<void>;
    // Viewer failure can never suppress the actual controller reset producer.
    try {
      original = reset(identity);
    } catch (error) {
      failure(error);
      original = Promise.resolve();
    }
    void original.then(
      () => {
        if (failed) reject(first);
        else resolve();
      },
      (error) => {
        failure(error);
        reject(first);
      }
    );
    return retained;
  }

  revokeController(identity: object): Promise<void> {
    return this.loss(identity, this.identityLost, this.resetIdentity);
  }
  revokeGrant(identity: object): Promise<void> {
    return this.loss(identity, this.grantLost, this.resetGrant);
  }

  /** Caller has already synchronously fenced host/grants and closed scope/identity producers. */
  settle(): Promise<void> {
    return Promise.allSettled([...this.work]).then((results) => {
      const first = results.find((result) => result.status === 'rejected');
      if (first?.status === 'rejected') this.failure(first.reason);
      if (this.failed) throw this.first;
    });
  }

  /** Fence original loss producers and join seat reset before native retirement.
   * Full viewer/capture closure is retained independently; native shutdown may be
   * needed to interrupt those original commands before their promises can settle.
   */
  prepareClose(): Promise<void> {
    if (this.preparing) return this.preparing;
    this.preparing = Promise.resolve().then(async () => {
      const complete = this.close();
      void complete.catch(() => {});
      let first: { value: unknown } | undefined;
      for (const result of await Promise.allSettled([...this.resetClosures]))
        if (result.status === 'rejected') first ??= { value: result.reason };
      try {
        await this.settle();
      } catch (value) {
        first ??= { value };
      }
      if (first) throw first.value;
    });
    return this.preparing;
  }

  /** Close captured original producers independently, then join every original loss/reset terminal. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let failed = this.failed,
      first: unknown = this.first;
    const failure = (error: unknown) => {
      this.failure(error);
      if (!failed) {
        failed = true;
        first = error;
      }
    };
    const operations: Promise<unknown>[] = [];
    for (const [index, close] of [
      this.closeHost,
      this.closeScope,
      this.closeGrants,
      this.closeIdentities,
    ].entries()) {
      try {
        const operation = Promise.resolve(close());
        operations.push(operation);
        if (index > 0) this.resetClosures.push(operation);
      } catch (error) {
        failure(error);
        if (index > 0) {
          const rejected = Promise.reject(error);
          void rejected.catch(() => {});
          this.resetClosures.push(rejected);
        }
      }
    }
    void Promise.allSettled(operations).then(async (results) => {
      for (const result of results) if (result.status === 'rejected') failure(result.reason);
      try {
        await this.settle();
      } catch (error) {
        failure(error);
      }
      if (failed) reject(first);
      else resolve();
    });
    return this.closing;
  }
}
