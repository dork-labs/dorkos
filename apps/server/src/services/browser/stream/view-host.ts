import type {
  PrivateViewerSampleObserver,
  PrivateViewerCensusObserver,
} from '../runtime/private-native-acceptance.js';
import {
  createOriginalBrowserViewerDiagnostic,
  type BrowserViewerDiagnosticStage,
} from './viewer-diagnostic.js';
import {
  originalCaptureCancellation,
  isOriginalCaptureCancellation,
} from './capture-cancellation.js';
import type { BrowserViewCapture } from './native-capture.js';
import type { Request, Response } from 'express';
import type { BrowserLifecycleEngine } from '@dorkos/browser/server-owner';
import { BrowserBindingSchema, type BrowserBinding } from '@dorkos/shared/browser-schemas';
import { resolveBrowserOriginFacts } from '../../../middleware/browser-origin.js';
import { isTrustedBrowserOrigin } from '../../../lib/trusted-origins.js';
import type { BrowserRegistry } from '../registry/registry.js';
import { BrowserRegistryError } from '../registry/errors.js';
import type { BrowserControllerIdentities } from '../api/controller-auth.js';
import {
  isOriginalBrowserGrantRefusal,
  type OwnedBrowserGrants,
  type BrowserViewerGrant,
} from '../api/grants.js';
import { BrowserPixelSubscriptions, ViewerRefusal } from './subscriptions.js';

const same = (a: BrowserBinding, b: BrowserBinding) =>
  (Object.keys(a) as (keyof BrowserBinding)[]).every((key) => a[key] === b[key]);

/** Private HTTP host; every incoming operation retains its own actual session verification. */
export class BrowserViewHost {
  private readonly diagnostic = createOriginalBrowserViewerDiagnostic();
  private readonly diagnosticContexts = new Map<
    string,
    { failed?: BrowserViewerDiagnosticStage }
  >();
  private readonly pixels: BrowserPixelSubscriptions;
  private readonly closeCapture: BrowserViewCapture['close'];
  private readonly captureIdentity: BrowserControllerIdentities['capture'];
  private readonly readInstance: BrowserRegistry['instance'];
  private readonly readTabs: BrowserLifecycleEngine['listTabs'];
  private readonly viewGrant: OwnedBrowserGrants['viewerGrant'];
  private readonly admitView: OwnedBrowserGrants['admitViewer'];
  private readonly ownerView: OwnedBrowserGrants['ownerView'];
  private readonly operations = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;
  private originalFailure?: Readonly<{ value: unknown }>;

  constructor(
    registry: BrowserRegistry,
    engine: BrowserLifecycleEngine,
    identities: BrowserControllerIdentities,
    grants: OwnedBrowserGrants,
    capture: BrowserViewCapture,
    private readonly enabled: () => boolean = () => false,
    viewerSamples?: PrivateViewerSampleObserver,
    viewerCensus?: PrivateViewerCensusObserver
  ) {
    this.pixels = new BrowserPixelSubscriptions(capture, viewerSamples, viewerCensus);
    this.closeCapture = capture.close.bind(capture);
    this.captureIdentity = identities.capture.bind(identities);
    this.readInstance = registry.instance.bind(registry);
    this.readTabs = engine.listTabs.bind(engine);
    this.viewGrant = grants.viewerGrant.bind(grants);
    this.admitView = grants.admitViewer.bind(grants);
    this.ownerView = grants.ownerView.bind(grants);
  }

  private origin(req: Request): string {
    const facts = resolveBrowserOriginFacts(req, { hostCheckInert: false });
    if (
      req.method !== 'POST' ||
      !facts.hostAllowed ||
      !facts.origin ||
      !isTrustedBrowserOrigin(facts, {
        allowNoOrigin: false,
        pairSameOriginWithHost: true,
      })
    )
      throw new ViewerRefusal('authority');
    return facts.origin;
  }

  private run<T>(req: Request, effect: (origin: string) => Promise<T>): Promise<T> {
    let origin: string;
    try {
      origin = this.origin(req);
      const enabled = this.enabled();
      if (!enabled || this.closed) throw new ViewerRefusal('authority');
      if (this.operations.size >= 16) throw new ViewerRefusal('capacity');
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = Promise.resolve().then(() => {
      if (this.closed) throw originalCaptureCancellation(new ViewerRefusal('authority'));
      return effect(origin);
    });
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation)
    );
    return operation;
  }

  issue(
    req: Request,
    res: Response,
    bindingValue: BrowserBinding,
    reference?: { grantId: string; revision: number },
    localTicket?: string
  ) {
    let stage: BrowserViewerDiagnosticStage = 'issue.origin-or-config';
    const context: { failed?: BrowserViewerDiagnosticStage } = {};
    return this.run(req, async (origin) => {
      stage = 'issue.binding';
      const binding = Object.freeze(BrowserBindingSchema.parse(bindingValue));
      stage = 'issue.auth';
      const auth = this.captureIdentity(req, res, localTicket);
      const refreshActor = auth.refresh.bind(auth),
        readActor = auth.current.bind(auth);
      if (this.closed) throw new ViewerRefusal('authority');
      stage = 'issue.auth';
      const actor = await refreshActor();
      const owner = actor.owner,
        actorIdentity = actor.credential;
      stage = 'issue.grant';
      let token: BrowserViewerGrant | undefined;
      if (reference)
        token = this.viewGrant(readActor, reference.grantId, reference.revision, binding);
      const admitted = token
        ? this.admitView(token, owner, binding)
        : this.ownerView(readActor, binding);
      const resourceOwner = admitted.owner,
        grantIdentity = token ? admitted.identity : undefined;
      const originalIdentity = admitted.identity;
      const current = () => {
        context.failed = undefined;
        if (this.closed) {
          context.failed = 'issue.current.actor';
          return false;
        }
        try {
          const readAdmission = () => {
            try {
              return token
                ? this.admitView(token, owner, binding)
                : this.ownerView(readActor, binding);
            } catch (error) {
              if (
                isOriginalBrowserGrantRefusal(error) &&
                (error.reason === 'unauthenticated' ||
                  error.reason === 'inaccessible' ||
                  error.reason === 'unavailable')
              )
                return undefined;
              throw error;
            }
          };
          stage = 'issue.current.admission';
          const first = readAdmission();
          if (!first || first.owner !== resourceOwner || first.identity !== originalIdentity) {
            context.failed = stage;
            return false;
          }
          stage = 'issue.current.registry';
          const registryDenials = new WeakSet<BrowserRegistryError>();
          let instance: ReturnType<BrowserRegistry['instance']>;
          try {
            instance = this.readInstance(
              resourceOwner,
              binding.browserId,
              binding.browserGeneration,
              (value) => registryDenials.add(value)
            );
          } catch (error) {
            if (
              error instanceof BrowserRegistryError &&
              registryDenials.has(error) &&
              (error.reason === 'inaccessible' ||
                error.reason === 'staleBinding' ||
                error.reason === 'stopped')
            ) {
              context.failed = 'issue.current.registry';
              return false;
            }
            throw error;
          }
          stage = 'issue.current.binding';
          const exact = this.readTabs(binding.browserId, binding.browserGeneration).some((tab) =>
            same(tab, binding)
          );
          stage = 'issue.current.final-admission';
          const final = readAdmission();
          stage = 'issue.current.config';
          const enabled = this.enabled();
          // All original resource/config reads precede the last actual actor read.
          stage = 'issue.current.actor';
          const observed = readActor();
          let admitted = false;
          stage = 'issue.current.registry';
          if (instance.status === 'running') {
            stage = 'issue.current.binding';
            if (exact) {
              stage = 'issue.current.final-admission';
              if (final?.owner === resourceOwner && final.identity === originalIdentity) {
                stage = 'issue.current.config';
                if (enabled) {
                  stage = 'issue.current.actor';
                  admitted =
                    !this.closed &&
                    observed?.owner === owner &&
                    observed.credential === actorIdentity;
                }
              }
            }
          }
          if (!admitted) context.failed = stage;
          return admitted;
        } catch (error) {
          // Unknown original resource/config/actor failure is retained independently from logical revocation.
          // A typed capture refusal must not erase this exact operational cause, including undefined.
          this.originalFailure ??= Object.freeze({ value: error });
          context.failed = stage;
          throw error;
        }
      };
      const refresh = async () => {
        if (this.closed) throw new ViewerRefusal('authority');
        const observed = await refreshActor();
        if (observed.owner !== owner || observed.credential !== actorIdentity || !current())
          throw new ViewerRefusal('authority');
      };
      stage = 'issue.final-origin';
      // Revalidate actual request origin after awaited session verification.
      if (this.origin(req) !== origin || !current()) throw new ViewerRefusal('authority');
      stage = 'issue.pixels';
      const issued = this.pixels.issue(
        Object.freeze({ actorIdentity, grantIdentity, binding, refresh, current }),
        origin
      );
      // Diagnostic-only bounded contexts: eviction never changes pixel or actor admission.
      if (this.diagnosticContexts.size >= 16)
        this.diagnosticContexts.delete(this.diagnosticContexts.keys().next().value!);
      this.diagnosticContexts.set(issued.token, context);
      return issued;
    }).catch((value: unknown) => {
      throw this.diagnostic.failure(context.failed ?? stage, value);
    });
  }

  /** Private router selection only; next/disconnect still perform original incoming authority checks. */
  ownsTicket(token: string): boolean {
    return !this.closed && this.pixels.ownsTicket(token);
  }

  next(req: Request, res: Response, ticket: string, priorReceipt?: unknown, localTicket?: string) {
    return this.run(req, async (origin) => {
      const auth = this.captureIdentity(req, res, localTicket);
      if (this.closed) throw new ViewerRefusal('authority');
      const actor = await auth.refresh();
      const admittedOrigin = this.origin(req),
        enabled = this.enabled();
      const current = auth.current();
      if (
        admittedOrigin !== origin ||
        !enabled ||
        this.closed ||
        current?.credential !== actor.credential ||
        current.owner !== actor.owner
      )
        throw new ViewerRefusal('authority');
      return this.pixels.next(ticket, origin, actor.credential, priorReceipt);
    });
  }

  disconnect(req: Request, res: Response, ticket: string, localTicket?: string) {
    return this.run(req, async (origin) => {
      const auth = this.captureIdentity(req, res, localTicket);
      if (this.closed) throw new ViewerRefusal('authority');
      const actor = await auth.refresh();
      const admittedOrigin = this.origin(req),
        enabled = this.enabled();
      const current = auth.current();
      if (
        admittedOrigin !== origin ||
        !enabled ||
        this.closed ||
        current?.credential !== actor.credential ||
        current.owner !== actor.owner
      )
        throw new ViewerRefusal('authority');
      this.pixels.disconnectFor(ticket, actor.credential);
    });
  }

  /** Mint a private response lease only from a fresh genuine incoming actor/origin check.
   * Numeric subscription expiry and metadata alone cannot mint this capability. */
  publication(req: Request, res: Response, ticket: string, frame?: unknown, localTicket?: string) {
    let stage: BrowserViewerDiagnosticStage = 'publication.origin-or-config';
    return this.run(req, async (origin) => {
      const auth = this.captureIdentity(req, res, localTicket);
      if (this.closed) throw new ViewerRefusal('authority');
      stage = 'publication.auth';
      const actor = await auth.refresh();
      const admittedOrigin = this.origin(req),
        enabled = this.enabled();
      const current = auth.current();
      stage = 'publication.actor';
      if (
        admittedOrigin !== origin ||
        !enabled ||
        this.closed ||
        current?.credential !== actor.credential ||
        current.owner !== actor.owner
      )
        throw new ViewerRefusal('authority');
      stage = 'publication.pixels';
      let original: ReturnType<BrowserPixelSubscriptions['publication']>;
      try {
        original = this.pixels.publication(ticket, origin, actor.credential, frame);
      } catch (value) {
        stage = this.diagnosticContexts.get(ticket)?.failed ?? stage;
        throw value;
      }
      return Object.freeze({
        publish: (effect: () => void) => {
          let publicationStage: BrowserViewerDiagnosticStage = 'publication.headers';
          try {
            // Serialization and response headers can run arbitrary synchronous callbacks.
            // Retain this exact incoming request authority, independently of the issuing request.
            const finalOrigin = this.origin(req),
              finalEnabled = this.enabled();
            const finalActor = auth.current();
            if (
              finalOrigin !== origin ||
              !finalEnabled ||
              this.closed ||
              finalActor?.credential !== actor.credential ||
              finalActor.owner !== actor.owner
            )
              throw new ViewerRefusal('authority');
            // The original viewer/pending-frame authority remains the final pixel bank fence.
            publicationStage = 'publication.publish';
            original.publish(effect);
          } catch (value) {
            throw this.diagnostic.failure(
              this.diagnosticContexts.get(ticket)?.failed ?? publicationStage,
              value
            );
          }
        },
        cancel: original.cancel,
      });
    }).catch((value: unknown) => {
      throw this.diagnostic.failure(stage, value);
    });
  }

  /** Bounded private custody observation, not a readiness or authorization projection. */
  viewerCount(): number {
    return this.pixels.viewerCount();
  }

  /** Captured controller-navigation loss clears original pixels before native reset begins. */
  bindingLost(binding: BrowserBinding): Promise<void> {
    return this.pixels.bindingLost(binding);
  }

  /** Original host loss hooks fence only corresponding subscriptions, never a controller on disconnect. */
  identityLost(identity: object): void {
    this.pixels.identityLost(identity);
  }
  grantLost(identity: object): void {
    this.pixels.grantLost(identity);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.diagnosticContexts.clear();
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const originalOperations = [...this.operations];
    let pixels: Promise<void>;
    try {
      pixels = this.pixels.close();
    } catch (error) {
      pixels = Promise.reject(error);
    }
    let captures: Promise<void>;
    try {
      captures = this.closeCapture();
    } catch (error) {
      captures = Promise.reject(error);
    }
    void Promise.allSettled([pixels, captures, ...originalOperations]).then((results) => {
      if (this.originalFailure) {
        reject(this.originalFailure.value);
        return;
      }
      const first = results.find(
        (result, index) =>
          result.status === 'rejected' &&
          (index < 2 || !isOriginalCaptureCancellation(result.reason))
      );
      if (first?.status === 'rejected') reject(first.reason);
      else resolve();
    });
    return this.closing;
  }
}
