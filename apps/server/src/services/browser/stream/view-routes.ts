import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { BrowserLifecycleError } from '@dorkos/browser';
import {
  BrowserBindingSchema,
  BrowserCounterSchema,
  BrowserReferenceSchema,
  BrowserRenderReceiptSchema,
  BrowserViewerSchema,
} from '@dorkos/shared/browser-schemas';
import { encodeBrowserFrameBody } from '@dorkos/shared/browser-frame-wire';
import { BrowserApiRefusal } from '../api/service.js';
import { BrowserRegistryError } from '../registry/errors.js';
import { ViewerRefusal } from './subscriptions.js';
import { isOriginalCaptureCancellation } from './capture-cancellation.js';
import type { BrowserViewHost } from './view-host.js';

const ticket = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const localTicket = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22,128}$/u)
  .optional();
const grant = z
  .object({ grantId: BrowserReferenceSchema, revision: BrowserCounterSchema })
  .strict()
  .optional();
const Issue = z.object({ binding: BrowserBindingSchema, grant, localTicket }).strict();
const Next = z
  .object({ ticket, receipt: BrowserRenderReceiptSchema.optional(), localTicket })
  .strict();
const Disconnect = z.object({ ticket, localTicket }).strict();
type Lease = Awaited<ReturnType<BrowserViewHost['publication']>>;

/** Private unmounted POST router. Tickets belong only in RAM/private bodies, never URLs or storage.
 * The eventual mount must provide genuine host policy, runtime readiness and default-off authority. */
export class BrowserViewRoutes {
  readonly router = Router();
  private readonly issue: BrowserViewHost['issue'];
  private readonly next: BrowserViewHost['next'];
  private readonly disconnect: BrowserViewHost['disconnect'];
  private readonly publication: BrowserViewHost['publication'];
  private readonly closeHost: BrowserViewHost['close'];
  private readonly work = new Set<Promise<void>>();
  private readonly fences = new Set<() => void>();
  private closed = false;
  private closing?: Promise<void>;
  private originalFailure?: Readonly<{ value: unknown }>;

  private recordOriginalFailure(value: unknown): void {
    this.originalFailure ??= Object.freeze({ value });
  }

  constructor(host: BrowserViewHost) {
    this.issue = host.issue.bind(host);
    this.next = host.next.bind(host);
    this.disconnect = host.disconnect.bind(host);
    this.publication = host.publication.bind(host);
    this.closeHost = host.close.bind(host);
    this.router.post('/viewers/issue', (req, res) => this.enter(req, res, 'issue'));
    this.router.post('/viewers/next', (req, res) => this.enter(req, res, 'next'));
    this.router.post('/viewers/disconnect', (req, res) => this.enter(req, res, 'disconnect'));
  }

  private enter(req: Request, res: Response, kind: 'issue' | 'next' | 'disconnect'): void {
    if (this.closed || this.work.size >= 16) {
      res.status(503).json({ error: 'Shared browser is unavailable' });
      return;
    }
    const operation = Promise.resolve().then(() => this.respond(req, res, kind));
    this.work.add(operation);
    void operation.then(
      () => this.work.delete(operation),
      () => this.work.delete(operation)
    );
  }

  private async respond(req: Request, res: Response, kind: 'issue' | 'next' | 'disconnect') {
    let lease: Lease | undefined,
      gone = this.closed || req.aborted || res.destroyed;
    let published = false,
      failed = false,
      first: unknown;
    const failure = (error: unknown) => {
      if (!failed) {
        failed = true;
        first = error;
      }
    };
    const destroy = res.destroy.bind(res);
    let cancelled = false;
    const cancel = () => {
      gone = true;
      if (cancelled) return;
      cancelled = true;
      let refused = false,
        original: unknown;
      for (const cleanup of [
        () => lease?.cancel(),
        () => {
          if (!res.writableEnded) destroy();
        },
      ]) {
        try {
          cleanup();
        } catch (error) {
          if (!refused) {
            refused = true;
            original = error;
          }
        }
      }
      if (refused) throw original;
    };
    // EventEmitter callers do not await retained work. Record cleanup refusal here instead
    // of throwing it into an unrelated request/socket stack; cancel still enters both originals.
    const requestAborted = () => {
      try {
        cancel();
      } catch (error) {
        failure(error);
        this.recordOriginalFailure(error);
      }
    };
    const responseClosed = () => {
      try {
        if (!res.writableEnded) cancel();
      } catch (error) {
        failure(error);
        this.recordOriginalFailure(error);
        try {
          cancel();
        } catch (cleanupError) {
          failure(cleanupError);
          this.recordOriginalFailure(cleanupError);
        }
      }
    };
    const reqOn = req.on.bind(req),
      reqOff = req.off.bind(req);
    const resOn = res.on.bind(res),
      resOff = res.off.bind(res);
    const header = res.setHeader.bind(res),
      end = res.end.bind(res);
    this.fences.add(cancel);
    try {
      reqOn('aborted', requestAborted);
      resOn('close', responseClosed);
      if (gone || this.closed) throw new ViewerRefusal('authority');
      let body: Buffer, contentType: string;
      if (kind === 'issue') {
        const input = Issue.parse(req.body);
        const issued = await this.issue(req, res, input.binding, input.grant, input.localTicket);
        lease = await this.publication(req, res, issued.token, undefined, input.localTicket);
        // Internal expiry is numeric; the public strict viewer DTO is explicitly UTC ISO.
        const viewer = BrowserViewerSchema.parse({
          viewerId: issued.viewerId,
          binding: issued.binding,
          expiresAt: new Date(issued.expiresAt).toISOString(),
        });
        body = Buffer.from(JSON.stringify({ viewer, ticket: issued.token }));
        contentType = 'application/json; charset=utf-8';
      } else if (kind === 'next') {
        const input = Next.parse(req.body);
        const frame = await this.next(req, res, input.ticket, input.receipt, input.localTicket);
        lease = await this.publication(
          req,
          res,
          input.ticket,
          frame.metadata.frame,
          input.localTicket
        );
        body = Buffer.from(encodeBrowserFrameBody(frame.metadata, frame.bytes));
        contentType = 'application/vnd.dorkos.browser-frame';
      } else {
        const input = Disconnect.parse(req.body);
        await this.disconnect(req, res, input.ticket, input.localTicket);
        body = Buffer.from('{}');
        contentType = 'application/json; charset=utf-8';
      }
      header('Cache-Control', 'no-store');
      header('Pragma', 'no-cache');
      header('X-Content-Type-Options', 'nosniff');
      header('Content-Type', contentType);
      header('Content-Length', body.byteLength);
      // Observe the actual client state before the final private original authority callback.
      const clientGone = gone || this.closed || req.aborted || res.destroyed || res.writableEnded;
      if (clientGone) {
        lease?.cancel();
        return;
      }
      if (lease)
        lease.publish(() => {
          // Original lease authority callbacks may synchronously close this route/client.
          // Only actual local state is read after authority returns, immediately before the original write.
          if (gone || req.aborted || res.destroyed || res.writableEnded || this.closed)
            throw new ViewerRefusal('authority');
          try {
            end(body);
          } catch (error) {
            this.recordOriginalFailure(error);
            throw error;
          }
          published = true;
        });
      else {
        try {
          end(body);
        } catch (error) {
          this.recordOriginalFailure(error);
          throw error;
        }
        published = true;
      }
    } catch (error) {
      failure(error);
      if (!gone && !this.closed && !res.destroyed && !res.headersSent) {
        const status =
          error instanceof z.ZodError
            ? 400
            : error instanceof BrowserApiRefusal && error.reason === 'unauthenticated'
              ? 401
              : error instanceof ViewerRefusal && error.reason === 'capacity'
                ? 503
                : error instanceof ViewerRefusal ||
                    (error instanceof BrowserApiRefusal && error.reason === 'inaccessible') ||
                    (error instanceof BrowserRegistryError &&
                      ['inaccessible', 'staleBinding', 'stopped'].includes(error.reason)) ||
                    // Original queued/entered capture revocation is inaccessible, not an
                    // operational failure. Preserve all other native failures as HTTP 500.
                    (error instanceof BrowserLifecycleError &&
                      ['STALE_BINDING', 'POLICY_REFUSED'].includes(error.code))
                  ? 404
                  : 500;
        try {
          res.status(status).json({
            error:
              status === 400
                ? 'Browser request couldn’t be read.'
                : status === 401
                  ? 'Sign in to access the shared browser'
                  : status === 404
                    ? 'Browser resource not found'
                    : 'Shared browser is unavailable',
          });
        } catch (outputError) {
          failure(outputError);
          this.recordOriginalFailure(outputError);
        }
      }
    } finally {
      this.fences.delete(cancel);
      for (const close of [
        () => reqOff('aborted', requestAborted),
        () => resOff('close', responseClosed),
        () => {
          if (!published) lease?.cancel();
        },
        () => {
          if (!published) cancel();
        },
      ]) {
        try {
          close();
        } catch (error) {
          failure(error);
          this.recordOriginalFailure(error);
        }
      }
    }
    // Request refusal remains the delivered outcome; only operational work poisons the close bank.
    // Finally failures were independently captured in originalFailure even behind a canceled request.
    if (failed && !isOriginalCaptureCancellation(first)) throw first;
  }

  /** Private custody count; only naturally settled original requests are removed. */
  pendingRequests(): number {
    return this.work.size;
  }

  /** Fence publication now; request cancellation never fakes original capture completion. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    for (const fence of this.fences) {
      try {
        fence();
      } catch (error) {
        this.recordOriginalFailure(error);
      }
    }
    const retainFailure = (operation: Promise<unknown>) =>
      operation.catch((error) => {
        this.recordOriginalFailure(error);
        throw error;
      });
    let host: Promise<void>;
    try {
      // Synchronous host fencing is independent of HTTP fence refusal; join its exact original later.
      host = this.closeHost();
    } catch (error) {
      this.recordOriginalFailure(error);
      host = Promise.reject(error);
    }
    const original = retainFailure(host);
    const requests = [...this.work].map(retainFailure);
    void Promise.allSettled([original, ...requests]).then(() => {
      if (this.originalFailure) reject(this.originalFailure.value);
      else resolve();
    });
    return this.closing;
  }
}
