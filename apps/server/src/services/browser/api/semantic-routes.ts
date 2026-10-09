import { ownSemanticDeliveryAbort } from './semantic-delivery-cancel.js';
import { Router, type Request, type Response } from 'express';
import type { BrowserSemanticReadHost } from './semantic-read-host.js';
const descriptor = Object.getOwnPropertyDescriptor;
const data = (owner: object, key: string) => {
  const value = descriptor(owner, key);
  return value && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : undefined;
};
/** Construct only from the actually installed authenticated semantic host; never a request flag. */
export class BrowserSemanticRoutes {
  readonly router = Router();
  private readonly wire: BrowserSemanticReadHost['wire'];
  private readonly closeHost: BrowserSemanticReadHost['close'];
  private readonly originals = new Set<Promise<void>>();
  private readonly fences = new Set<() => void>();
  private closed = false;
  private closing?: Promise<void>;
  private first?: Readonly<{ value: unknown }>;
  private throwOriginalFailure(): void {
    if (this.first) throw this.first.value;
  }

  constructor(host: BrowserSemanticReadHost) {
    this.wire = host.wire.bind(host);
    this.closeHost = host.close.bind(host);
    for (const owner of [false, true])
      for (const kind of ['read', 'action', 'stream', 'next', 'close'] as const)
        this.router.post(`/semantic/${owner ? 'owner/' : ''}${kind}`, (req, res) => {
          if (this.closed || this.first || this.originals.size >= 16) {
            res.status(503).json({ error: 'Shared browser is unavailable.' });
            return;
          }
          const original = Promise.resolve().then(() => this.respond(kind, req, res, owner));
          this.originals.add(original);
          void original.then(
            () => this.originals.delete(original),
            (value) => {
              this.first ??= { value };
              this.originals.delete(original);
            }
          );
        });
  }
  private async respond(
    kind: Parameters<BrowserSemanticReadHost['wire']>[0],
    req: Request,
    res: Response,
    owner: boolean
  ) {
    this.throwOriginalFailure();
    const controller = new AbortController();
    const ownedAbort = ownSemanticDeliveryAbort(controller);
    const reqOn = req.on.bind(req),
      reqOff = req.off.bind(req),
      on = res.on.bind(res),
      off = res.off.bind(res),
      end = res.end.bind(res),
      header = res.setHeader.bind(res),
      destroy = res.destroy.bind(res);
    let delivered = false,
      gone = this.closed;
    let finish: Promise<void> | undefined;
    let finishResolve: (() => void) | undefined,
      finishReject: ((value: unknown) => void) | undefined;
    const abort = () => {
      gone = true;
      ownedAbort.cancel();
      finishReject?.(ownedAbort.reason);
    };
    const finished = () => {
      delivered = true;
      finishResolve?.();
    };
    let delivery: Awaited<ReturnType<BrowserSemanticReadHost['wire']>> | undefined;
    let delegated = false;
    this.fences.add(abort);
    try {
      reqOn('aborted', abort);
      on('close', abort);
      this.throwOriginalFailure();
      const body = req.body;
      this.throwOriginalFailure();
      if (gone || this.closed) throw ownedAbort.reason;
      const original = this.wire(kind, req, res, body, controller.signal, owner);
      delegated = true;
      delivery = await original;
      if (gone || this.closed) return;
      header('Content-Type', 'application/json; charset=utf-8');
      header('Cache-Control', 'no-store');
      res.status(200);
      finish = new Promise<void>((resolve, reject) => {
        finishResolve = resolve;
        finishReject = reject;
      });
      void finish.catch(() => {});
      on('finish', finished);
      delivery.publish((body, check) => {
        check();
        if (
          gone ||
          this.closed ||
          this.first ||
          controller.signal.aborted ||
          data(req, 'aborted') !== false ||
          data(res, 'destroyed') !== false ||
          data(res, 'writable') !== true ||
          data(res, 'finished') !== false ||
          data(res, 'statusCode') !== 200
        )
          throw new Error('SEMANTIC_RESPONSE_REFUSED');
        end(body);
      });
      await finish;
    } catch (value) {
      // Before delegation, no host bank owns original request/listener acquisition failures.
      // After delegation the host owns its parser/auth/native faults; publication remains ours.
      if (
        value !== ownedAbort.reason &&
        (!delegated || (delivery && !delivery.isOriginalRefusal(value)))
      )
        this.first ??= { value };
      if (!gone && !this.closed)
        try {
          res.status(503).json({ error: 'The page could not be read.' });
        } catch (value) {
          this.first ??= { value };
          try {
            destroy();
          } catch (value) {
            this.first ??= { value };
          }
        }
    } finally {
      if (delivery && !delivered)
        try {
          await delivery.discard();
        } catch (value) {
          this.first ??= { value };
        }
      for (const remove of [
        () => reqOff('aborted', abort),
        () => off('close', abort),
        () => off('finish', finished),
      ])
        try {
          remove();
        } catch (value) {
          this.first ??= { value };
        }
      this.fences.delete(abort);
    }
  }
  /** Fence delivery first, independently start host closure, and join every original response. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      const host = Promise.resolve().then(this.closeHost);
      void host.catch(() => {});
      for (const fence of this.fences)
        try {
          fence();
        } catch (value) {
          this.first ??= { value };
        }
      await Promise.allSettled([...this.originals]);
      try {
        await host;
      } catch (value) {
        this.first ??= { value };
      }
      this.throwOriginalFailure();
    });
    return this.closing;
  }
}
