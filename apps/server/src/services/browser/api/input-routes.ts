import { projectBrowserActionReceipt } from './action-receipt.js';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  BrowserInputRequestSchema,
  BrowserCopySelectionRequestSchema,
  BrowserCopySelectionReceiptSchema,
  BrowserReferenceSchema,
  BrowserCounterSchema,
} from '@dorkos/shared/browser-schemas';
import { resolveBrowserOriginFacts } from '../../../middleware/browser-origin.js';
import { isTrustedBrowserOrigin } from '../../../lib/trusted-origins.js';
import { BrowserApiRefusal } from './service.js';
import type { BrowserControllerInput } from './controller-input.js';
import type { BrowserControllerHost } from './controller-host.js';

const Input = z
  .object({
    command: BrowserInputRequestSchema,
    controllerId: BrowserReferenceSchema,
    grant: z
      .object({
        grantId: BrowserReferenceSchema,
        revision: BrowserCounterSchema,
      })
      .strict()
      .optional(),
    localTicket: z
      .string()
      .regex(/^[A-Za-z0-9_-]{22,128}$/u)
      .optional(),
  })
  .strict();

const Copy = Input.extend({ command: BrowserCopySelectionRequestSchema }).strict();

/** Private unmounted input delivery. Existing original controller/consent grants every native step.
 * The eventual owner supplies the real config/runtime policy; this router never takes over control. */
export class BrowserInputRoutes {
  readonly router = Router();
  private readonly capture: BrowserControllerInput['capture'];
  private readonly closeInput: BrowserControllerInput['close'];
  private readonly captureController: BrowserControllerHost['capture'];
  private readonly work = new Set<Promise<void>>();
  private readonly fences = new Set<() => void>();
  private closed = false;
  private closing?: Promise<void>;
  private failure?: Readonly<{ value: unknown }>;

  constructor(
    input: BrowserControllerInput,
    controller: BrowserControllerHost,
    private readonly available: () => boolean = () => false
  ) {
    this.capture = input.capture.bind(input);
    this.captureController = controller.capture.bind(controller);
    this.closeInput = input.close.bind(input);
    for (const [path, copy] of [
      ['/input', false],
      ['/copy-selection', true],
    ] as const)
      this.router.post(path, (req, res) => {
        if (this.closed || this.work.size >= 16) {
          res.status(503).json({ error: 'Shared browser is unavailable' });
          return;
        }
        const original = Promise.resolve().then(() => this.respond(req, res, copy));
        this.work.add(original);
        void original.then(
          () => this.work.delete(original),
          () => this.work.delete(original)
        );
      });
  }

  private policy(req: Request): string {
    const facts = resolveBrowserOriginFacts(req, { hostCheckInert: false });
    if (
      this.closed ||
      !this.available() ||
      req.method !== 'POST' ||
      !facts.hostAllowed ||
      !facts.origin ||
      !isTrustedBrowserOrigin(facts, {
        allowNoOrigin: false,
        pairSameOriginWithHost: true,
      })
    )
      throw new BrowserApiRefusal('inaccessible');
    return facts.origin;
  }

  private async respond(req: Request, res: Response, copy = false): Promise<void> {
    const abort = new AbortController();
    let gone = this.closed || req.aborted || res.destroyed;
    const destroy = res.destroy.bind(res),
      reqOn = req.on.bind(req),
      reqOff = req.off.bind(req),
      resOn = res.on.bind(res),
      resOff = res.off.bind(res);
    let resolveWire!: () => void, rejectWire!: (value: unknown) => void;
    let resolvePublication!: () => void, rejectPublication!: (value: unknown) => void;
    const wire = new Promise<void>((yes, no) => {
      resolveWire = yes;
      rejectWire = no;
    });
    const publication = new Promise<void>((yes, no) => {
      resolvePublication = yes;
      rejectPublication = no;
    });
    // A normal request need not navigate. Reserve observers before native entry without
    // permitting an unobserved denial to become an unhandled promise rejection.
    void wire.catch(() => {});
    void publication.catch(() => {});
    let finished = false,
      endReturned = false,
      publicationSettled = false;
    let publicationFailure: Readonly<{ value: unknown }> | undefined;
    const rejectPublished = (value: unknown) => {
      publicationFailure ??= Object.freeze({ value });
      if (!publicationSettled) {
        publicationSettled = true;
        rejectPublication(publicationFailure.value);
      }
      rejectWire(publicationFailure.value);
    };
    const responseFinished = () => {
      try {
        const observed = res.writableFinished;
        const status = res.statusCode;
        if (!observed || status !== 200 || gone || this.closed) {
          rejectPublished(new BrowserApiRefusal('inaccessible'));
          return;
        }
        finished = true;
        resolveWire();
      } catch (value) {
        rejectPublished(value);
        record(value);
      }
    };
    const record = (value: unknown) => {
      publicationFailure ??= Object.freeze({ value });
      this.failure ??= Object.freeze({ value });
    };
    let cancelled = false;
    const originalAbort = abort.abort.bind(abort);
    const fence = () => {
      gone = true;
      if (cancelled) return;
      cancelled = true;
      let failed = false,
        first: unknown;
      for (const cleanup of [
        () => originalAbort(),
        () => {
          if (!res.writableEnded) destroy();
        },
      ]) {
        try {
          cleanup();
        } catch (error) {
          if (!failed) {
            failed = true;
            first = error;
          }
        }
      }
      rejectPublished(failed ? first : new BrowserApiRefusal('inaccessible'));
      if (failed) throw first;
    };
    const eventFence = () => {
      try {
        fence();
      } catch (error) {
        record(error);
      }
    };
    const responseClosed = () => {
      if (!finished) eventFence();
    };
    this.fences.add(eventFence);
    try {
      reqOn('aborted', eventFence);
      resOn('close', responseClosed);
      resOn('finish', responseFinished);
      const body = copy ? Copy.parse(req.body) : Input.parse(req.body);
      const origin = this.policy(req);
      if (gone) {
        eventFence();
        return;
      }
      const client = this.capture(req, res, body.localTicket, () => publication);
      // Retain the original auth/native operation through settlement; abort is only notification.
      const result = copy
        ? await client.copySelection(body.command, body.controllerId, body.grant, abort.signal)
        : await client.input(body.command, body.controllerId, body.grant, abort.signal);
      if (gone || req.aborted || res.destroyed || res.writableEnded || this.closed) return;
      if (this.policy(req) !== origin) throw new BrowserApiRefusal('inaccessible');
      // This second original incoming-request capture supplies publication authority only.
      // It never dispatches input, takes over a controller, or interprets a wire receipt as consent.
      const incoming = this.captureController(req, res, body.localTicket);
      const authorization = await (
        copy ? incoming.copyAuthorization.bind(incoming) : incoming.authorization.bind(incoming)
      )(body.command.binding, body.controllerId, body.grant);
      const current = authorization.isCurrent.bind(authorization);
      const receipt = copy
        ? BrowserCopySelectionReceiptSchema.parse(result)
        : projectBrowserActionReceipt(result);
      if (
        receipt.requestId !== body.command.requestId ||
        (Object.keys(body.command.binding) as (keyof typeof body.command.binding)[]).some(
          (key) => receipt.binding[key] !== body.command.binding[key]
        )
      )
        throw new Error('Original input returned an uncorrelated result.');
      const bytes = Buffer.from(JSON.stringify(receipt));
      const header = res.setHeader.bind(res),
        end = res.end.bind(res);
      header('Cache-Control', 'no-store');
      header('Pragma', 'no-cache');
      header('X-Content-Type-Options', 'nosniff');
      header('Content-Type', 'application/json; charset=utf-8');
      header('Content-Length', bytes.byteLength);
      // Header/serialization callbacks precede the final genuine incoming/controller check.
      const clientGone = gone || this.closed || req.aborted || res.destroyed || res.writableEnded;
      if (clientGone) {
        eventFence();
        return;
      }
      // Read original response qualification before the final fallible authority checks.
      // A getter may synchronously revoke the actor/configuration while returning 200.
      const status = res.statusCode;
      if (status !== 200 || this.policy(req) !== origin || !current())
        throw new BrowserApiRefusal('inaccessible');
      // Original policy/current callbacks can synchronously close this owner. No callbacks
      // may run between this final local state fence and the captured response end.
      if (
        gone ||
        this.closed ||
        abort.signal.aborted ||
        req.aborted ||
        res.destroyed ||
        res.writableEnded
      ) {
        eventFence();
        return;
      }
      end(bytes);
      endReturned = true;
      await wire;
    } catch (error) {
      rejectPublished(error);
      const ordinary = error instanceof BrowserApiRefusal || error instanceof z.ZodError;
      if (!ordinary) record(error);
      if (!gone && !res.destroyed && !res.writableEnded) {
        try {
          res
            .status(
              error instanceof z.ZodError ? 400 : error instanceof BrowserApiRefusal ? 403 : 503
            )
            .json({ error: 'Shared browser input is unavailable' });
        } catch (deliveryError) {
          record(deliveryError);
          eventFence();
        }
      }
    } finally {
      for (const remove of [
        () => reqOff('aborted', eventFence),
        () => resOff('close', responseClosed),
        () => resOff('finish', responseFinished),
      ]) {
        try {
          remove();
        } catch (error) {
          record(error);
        }
      }
      this.fences.delete(eventFence);
      // Only the original successful end, actual finish and independently returned
      // listener closures publish this private capability. No client-body ACK is used.
      if (!publicationSettled) {
        if (endReturned && finished && !gone && !this.closed && !publicationFailure) {
          publicationSettled = true;
          resolvePublication();
        } else
          rejectPublished(
            publicationFailure ? publicationFailure.value : new BrowserApiRefusal('inaccessible')
          );
      }
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    for (const fence of this.fences) fence();
    const originalInput = Promise.resolve().then(() => this.closeInput());
    void Promise.allSettled([originalInput, ...this.work]).then((results) => {
      for (const result of results)
        if (result.status === 'rejected') this.failure ??= Object.freeze({ value: result.reason });
      if (this.failure) reject(this.failure.value);
      else resolve();
    });
    return this.closing;
  }
}
