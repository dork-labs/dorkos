import type { Request, Response } from 'express';
import {
  isOriginalBrowserDiagnosticRefusal,
  type BrowserLifecycleEngine,
} from '@dorkos/browser/server-owner';
import { ZodError } from 'zod';
import {
  BrowserDiagnosticsRequestSchema,
  BrowserDiagnosticSummarySchema,
} from '@dorkos/shared/browser-schemas';
import { resolveBrowserOriginFacts } from '../../../middleware/browser-origin.js';
import { isTrustedBrowserOrigin } from '../../../lib/trusted-origins.js';
import {
  isOriginalBrowserIdentityRefusal,
  type BrowserControllerIdentities,
} from './controller-auth.js';
import { isOriginalBrowserGrantRefusal, type OwnedBrowserGrants } from './grants.js';
import { BrowserApiRefusal } from './service.js';

const originalDiagnosticsRefusals = new WeakSet<object>();
const originalMalformedRequests = new WeakSet<object>();
/** Only this receiver's actual request parse can qualify as a malformed request. */
export function isOriginalDiagnosticsMalformed(value: unknown): boolean {
  return !!value && typeof value === 'object' && originalMalformedRequests.has(value);
}
/** Only original local/identity/grant/engine denials qualify as an ordinary refusal. */
export function isOriginalDiagnosticsRefusal(value: unknown): boolean {
  return (
    (!!value && typeof value === 'object' && originalDiagnosticsRefusals.has(value)) ||
    isOriginalBrowserIdentityRefusal(value) ||
    isOriginalBrowserGrantRefusal(value) ||
    isOriginalBrowserDiagnosticRefusal(value)
  );
}
/** Original private route/host refusal, independent of producer-thrown typed errors. */
export function diagnosticsRefusal(reason: BrowserApiRefusal['reason']): BrowserApiRefusal {
  const error = new BrowserApiRefusal(reason);
  originalDiagnosticsRefusals.add(error);
  return error;
}

/** Private read-only request composition over exact original engine and diagnostic grant producers. */
export class BrowserDiagnosticsHost {
  private readonly read: BrowserLifecycleEngine['diagnostics'];
  private readonly admit: OwnedBrowserGrants['admit'];
  private readonly captureIdentity: BrowserControllerIdentities['capture'];
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;
  private first?: Readonly<{ value: unknown }>;
  private observeFailure(value: unknown): void {
    if (!isOriginalDiagnosticsRefusal(value) && !isOriginalDiagnosticsMalformed(value))
      this.first ??= Object.freeze({ value });
  }
  private throwOriginalFailure(): void {
    if (this.first) throw this.first.value;
  }

  constructor(
    engine: Pick<BrowserLifecycleEngine, 'diagnostics'>,
    grants: Pick<OwnedBrowserGrants, 'admit'>,
    identities: Pick<BrowserControllerIdentities, 'capture'>,
    private readonly enabled: () => boolean = () => false
  ) {
    this.read = engine.diagnostics.bind(engine);
    this.admit = grants.admit.bind(grants);
    this.captureIdentity = identities.capture.bind(identities);
  }
  private origin(req: Request): string {
    this.throwOriginalFailure();
    const facts = resolveBrowserOriginFacts(req, { hostCheckInert: false });
    if (
      this.closed ||
      !this.enabled() ||
      req.method !== 'POST' ||
      !facts.hostAllowed ||
      !facts.origin ||
      !isTrustedBrowserOrigin(facts, {
        allowNoOrigin: false,
        pairSameOriginWithHost: true,
      })
    )
      throw diagnosticsRefusal('inaccessible');
    return facts.origin;
  }
  /** Fresh server-store authentication before original read and again before actual delivery. */
  capture(req: Request, res: Response, value: unknown, signal: AbortSignal) {
    if (this.first) return Promise.reject(this.first.value);
    if (this.closed || this.pending.size >= 16) throw diagnosticsRefusal('unavailable');
    const operation = Promise.resolve().then(async () => {
      this.throwOriginalFailure();
      if (signal.aborted) throw diagnosticsRefusal('inaccessible');
      let request: ReturnType<typeof BrowserDiagnosticsRequestSchema.parse>;
      try {
        request = BrowserDiagnosticsRequestSchema.parse(value);
      } catch (error) {
        if (error instanceof ZodError) originalMalformedRequests.add(error);
        throw error;
      }
      const auth = this.captureIdentity(req, res);
      const admittedOrigin = this.origin(req);
      const actor = await auth.refresh();
      const check = () => {
        this.throwOriginalFailure();
        if (signal.aborted) throw diagnosticsRefusal('inaccessible');
        if (this.origin(req) !== admittedOrigin) throw diagnosticsRefusal('inaccessible');
        this.admit(
          auth.current,
          request.grant.grantId,
          request.grant.revision,
          request.binding,
          'browser.diagnostics'
        );
        const final = auth.current();
        if (
          this.closed ||
          signal.aborted ||
          final?.owner !== actor.owner ||
          final.credential !== actor.credential
        )
          throw diagnosticsRefusal('inaccessible');
        this.throwOriginalFailure();
      };
      check();
      const summary = BrowserDiagnosticSummarySchema.parse(this.read(request.binding));
      if (
        Object.keys(request.binding).some(
          (key) =>
            summary.binding[key as keyof typeof request.binding] !==
            request.binding[key as keyof typeof request.binding]
        )
      )
        throw diagnosticsRefusal('inaccessible');
      const bytes = JSON.stringify(summary);
      if (Buffer.byteLength(bytes) > 266240) throw diagnosticsRefusal('unavailable');
      await auth.refresh();
      check();
      let published = false;
      return Object.freeze({
        publish: (effect: (bytes: string, finalCheck: () => void) => void) => {
          try {
            if (published) throw diagnosticsRefusal('inaccessible');
            check();
            published = true;
            effect(bytes, check);
          } catch (value) {
            this.observeFailure(value);
            throw value;
          }
        },
      });
    });
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      (value) => {
        this.observeFailure(value);
        this.pending.delete(operation);
      }
    );
    return operation;
  }
  /** Fence admission immediately and join original auth/read work, without closing the shared engine. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.pending]);
      this.throwOriginalFailure();
    });
    return this.closing;
  }
}
