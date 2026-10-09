import { Router, type Request, type Response } from 'express';
import {
  isOriginalDiagnosticsRefusal,
  diagnosticsRefusal,
  isOriginalDiagnosticsMalformed,
  type BrowserDiagnosticsHost,
} from './diagnostics-host.js';

const originalDescriptor = Object.getOwnPropertyDescriptor;
function ownData(owner: object, key: string): unknown {
  const descriptor = originalDescriptor(owner, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : undefined;
}
/** Actual Node own data only; application accessors cannot run after the authority fence. */
function responseCanPublish(req: Request, res: Response): boolean {
  return (
    ownData(res, 'statusCode') === 200 &&
    ownData(req, 'aborted') === false &&
    ownData(res, 'destroyed') === false &&
    ownData(res, 'finished') === false &&
    ownData(res, 'writable') === true
  );
}

/** Private bounded JSON delivery; the production composition must mount it explicitly. */
export class BrowserDiagnosticsRoutes {
  readonly router = Router();
  private readonly capture: BrowserDiagnosticsHost['capture'];
  private readonly closeHost: BrowserDiagnosticsHost['close'];
  private readonly work = new Set<Promise<void>>();
  private readonly fences = new Set<() => void>();
  private closed = false;
  private closing?: Promise<void>;
  private failure?: Readonly<{ value: unknown }>;
  private throwOriginalFailure(): void {
    if (this.failure) throw this.failure.value;
  }

  constructor(host: BrowserDiagnosticsHost) {
    this.capture = host.capture.bind(host);
    this.closeHost = host.close.bind(host);
    this.router.post('/diagnostics', (req, res) => {
      if (this.closed || this.failure || this.work.size >= 16) {
        res.status(503).json({ error: 'Shared browser is unavailable.' });
        return;
      }
      const original = Promise.resolve().then(() => this.respond(req, res));
      this.work.add(original);
      void original.then(
        () => this.work.delete(original),
        (value) => {
          this.failure ??= Object.freeze({ value });
          try {
            res.destroy();
          } catch (cleanup) {
            this.failure ??= Object.freeze({ value: cleanup });
          }
          this.work.delete(original);
        }
      );
    });
  }
  private async respond(req: Request, res: Response): Promise<void> {
    this.throwOriginalFailure();
    const controller = new AbortController();
    const reqOn = req.on.bind(req),
      reqOff = req.off.bind(req),
      resOn = res.on.bind(res),
      resOff = res.off.bind(res),
      destroy = res.destroy.bind(res),
      send = res.end.bind(res),
      header = res.setHeader.bind(res);
    let gone = this.closed || req.aborted || res.destroyed;
    const record = (value: unknown) => {
      this.failure ??= Object.freeze({ value });
    };
    const cancel = () => {
      gone = true;
      try {
        controller.abort(diagnosticsRefusal('inaccessible'));
      } catch (cause) {
        record(cause);
      }
    };
    this.fences.add(cancel);
    try {
      reqOn('aborted', cancel);
      resOn('close', cancel);
      if (gone) cancel();
      this.throwOriginalFailure();
      const delivery = await this.capture(req, res, req.body, controller.signal);
      this.throwOriginalFailure();
      if (gone || this.closed) return;
      header('Content-Type', 'application/json; charset=utf-8');
      header('Cache-Control', 'no-store');
      res.status(200);
      delivery.publish((bytes, finalCheck) => {
        this.throwOriginalFailure();
        finalCheck();
        this.throwOriginalFailure();
        // res.status(200) creates the original Node statusCode own data property.
        // Authority callbacks can change it; accessors/replaced unknown state are refused.
        if (!responseCanPublish(req, res)) throw diagnosticsRefusal('inaccessible');
        if (gone || this.closed || controller.signal.aborted)
          throw diagnosticsRefusal('inaccessible');
        send(bytes);
      });
    } catch (cause) {
      const denied = isOriginalDiagnosticsRefusal(cause);
      const malformed = isOriginalDiagnosticsMalformed(cause);
      if (!denied && !malformed) record(cause);
      if (gone || this.closed) return;
      try {
        res.status(malformed ? 400 : denied ? 404 : 503).json({
          error: malformed
            ? 'Browser request couldn’t be read.'
            : denied
              ? 'Shared browser is unavailable.'
              : 'Shared browser details couldn’t be read.',
        });
      } catch (error) {
        record(error);
        try {
          destroy();
        } catch (error) {
          record(error);
        }
      }
    } finally {
      for (const remove of [() => reqOff('aborted', cancel), () => resOff('close', cancel)]) {
        try {
          remove();
        } catch (cause) {
          record(cause);
        }
      }
      this.fences.delete(cancel);
    }
  }
  /** Immediate delivery fence, then exact original auth/read/listener settlement. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    let resolve!: () => void, reject!: (reason: unknown) => void;
    this.closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    for (const fence of this.fences) fence();
    let hostClosing: Promise<void> | undefined;
    try {
      hostClosing = this.closeHost();
    } catch (value) {
      this.failure ??= Object.freeze({ value });
    }
    if (hostClosing) void hostClosing.catch(() => undefined);
    void Promise.resolve().then(async () => {
      await Promise.allSettled([...this.work]);
      try {
        await hostClosing;
      } catch (value) {
        this.failure ??= Object.freeze({ value });
      }
      if (this.failure) reject(this.failure.value);
      else resolve();
    });
    void this.closing.catch(() => undefined);
    return this.closing;
  }
}
