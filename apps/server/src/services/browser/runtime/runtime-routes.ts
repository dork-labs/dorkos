import { createOriginalBrowserNavigationRefusalDiagnostic } from './diagnostics/navigation-refusal.js';
import {
  createOriginalBrowserViewerDiagnostic,
  type BrowserViewerDiagnosticStage,
} from '../stream/viewer-diagnostic.js';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  BrowserLocalDestinationRequestSchema,
  BrowserLocalDestinationReceiptSchema,
  BrowserProductionNavigateRequestSchema,
  BrowserProductionNavigateReceiptSchema,
  BrowserProductionOpenRequestSchema,
  BrowserProductionProfileImportRequestSchema,
  BrowserProductionProfileImportReceiptSchema,
  BrowserProductionProfileCreateRequestSchema,
  BrowserProductionProfileCreateReceiptSchema,
  BrowserProductionOpenReceiptSchema,
  BrowserOpenRequestSchema,
  BrowserInstanceSchema,
  BrowserNavigateRequestSchema,
  BrowserControlSchema,
  BrowserBindingSchema,
  BrowserCloseRequestSchema,
  BrowserCloseReceiptSchema,
  BrowserCounterSchema,
  BrowserReferenceSchema,
} from '@dorkos/shared/browser-schemas';
import { resolveBrowserOriginFacts } from '../../../middleware/browser-origin.js';
import { isTrustedBrowserOrigin } from '../../../lib/trusted-origins.js';
import { createBrowserRouter } from '../../../routes/browser.js';
import { BrowserApiService } from '../api/service.js';
import { BrokerError } from '../egress/broker/errors.js';
import type { createProductionBrowserStartupMode } from './startup-mode.js';

// Express Router.bind registers the HTTP BIND verb; capture the function intrinsic instead.
const originalFunctionBind = Function.prototype.bind;
const originalDescriptor = Object.getOwnPropertyDescriptor;
const originalHasOwn = Object.prototype.hasOwnProperty;
function ownData(owner: object, key: string): unknown {
  const descriptor = originalDescriptor(owner, key);
  return descriptor && Reflect.apply(originalHasOwn, descriptor, ['value'])
    ? descriptor.value
    : undefined;
}
/** Actual Node own data; no request/response accessor runs after the final actor fence. */
function responseCanPublish(req: Request, res: Response): boolean {
  return (
    ownData(res, 'statusCode') === 200 &&
    ownData(req, 'aborted') === false &&
    ownData(res, 'destroyed') === false &&
    ownData(res, 'finished') === false &&
    ownData(res, 'writable') === true
  );
}

/** Real owner-qualified production router. Startup mounts this exact retained object;
 * status/enable never confer workspace, viewer, controller or native-input permission. */
export function createProductionBrowserRuntimeRoutes(
  mode: ReturnType<typeof createProductionBrowserStartupMode>
) {
  const closeMode = mode.close.bind(mode);
  const expectedModeRefusal = mode.isOriginalStartupRefusal.bind(mode);
  const modeCurrent = mode.modeCurrent.bind(mode);
  const captureOwner = mode.captureOwner.bind(mode);
  const fenceRequests = mode.fenceRequests.bind(mode);
  const router = Router();
  const viewerDiagnostic = createOriginalBrowserViewerDiagnostic();
  const navigationDiagnostic = createOriginalBrowserNavigationRefusalDiagnostic();
  const work = new Set<Promise<void>>();
  const cancellations = new Set<() => void>();
  let closed = false,
    closing: Promise<void> | undefined;
  let first: { reason: unknown } | undefined;
  const fail = (reason: unknown) => {
    if (first) return;
    first = { reason };
    // Revoke the genuine retained session/grant predicates before an auth await resumes.
    // This synchronous original fence neither aborts nor substitutes native cleanup.
    try {
      fenceRequests(reason);
    } catch {
      // The original cause remains first; local route admission still stays refused.
    }
  };
  // Fence every mounted route, including delegated viewer/input and metadata routes.
  // A retained original failure permanently closes admission until this owner is replaced.
  router.use((_req, res, next) => {
    if (!closed && !first) return next();
    try {
      res.status(503).json({ error: 'Shared browser is unavailable' });
    } catch (reason) {
      fail(reason);
    }
  });
  // Only failures minted by this local admission or input parser are ordinary HTTP denials.
  // Original participant/transport failures never gain that provenance from their class.
  const localDenials = new WeakSet<object>();
  const refusal = (code: ConstructorParameters<typeof BrokerError>[0]) => {
    const reason = new BrokerError(code);
    localDenials.add(reason);
    return reason;
  };
  const requireAvailable = () => {
    if (first) throw first.reason;
    if (closed) throw refusal('CLOSED');
  };
  const parseInput = <T>(schema: { parse(value: unknown): T }, value: unknown): T => {
    try {
      return schema.parse(value);
    } catch (reason) {
      if (reason instanceof z.ZodError) localDenials.add(reason);
      throw reason;
    }
  };
  const origin = (req: Request) => {
    const facts = resolveBrowserOriginFacts(req, { hostCheckInert: false });
    const reading = req.method === 'GET';
    if (
      !facts.hostAllowed ||
      (!reading && !facts.origin) ||
      !isTrustedBrowserOrigin(facts, {
        allowNoOrigin: reading,
        pairSameOriginWithHost: true,
      })
    )
      throw refusal('AUTHORITY_REFUSED');
    return facts.origin;
  };
  const handle =
    (
      operation: (req: Request, res: Response, signal: AbortSignal) => Promise<unknown>,
      navigationOperation = false
    ) =>
    (req: Request, res: Response) => {
      if (closed || first || work.size >= 16) {
        try {
          res.status(503).json({ error: 'Shared browser is unavailable' });
        } catch (reason) {
          fail(reason);
        }
        return;
      }
      let resolveOriginal!: () => void, rejectOriginal!: (value: unknown) => void;
      const original = new Promise<void>((yes, no) => {
        resolveOriginal = yes;
        rejectOriginal = no;
      });
      // Whole operation custody precedes all request/response getters and original callbacks.
      work.add(original);
      void original.then(
        () => work.delete(original),
        (reason) => {
          fail(reason);
          work.delete(original);
        }
      );
      const cleanup: (() => unknown)[] = [];
      let primary: Readonly<{ reason: unknown }> | undefined;
      const retain = (reason: unknown) => {
        primary ??= { reason };
        fail(reason);
      };
      const finish = async () => {
        for (const duty of cleanup) {
          try {
            await duty();
          } catch (reason) {
            retain(reason);
          }
        }
        if (primary) throw primary.reason;
      };
      let publication: Promise<void> | undefined;
      let rejectPublication: ((reason: unknown) => void) | undefined;
      try {
        const abort = new AbortController();
        const originalAbort = abort.abort.bind(abort);
        const originalEnd = res.end.bind(res);
        const originalDestroy = res.destroy.bind(res);
        let gone = req.aborted || res.destroyed,
          lossEntered = false;
        const lost = () => {
          gone = true;
          if (lossEntered) return;
          lossEntered = true;
          const reason = refusal('CLOSED');
          rejectPublication?.(reason);
          for (const duty of [() => originalAbort(), () => originalDestroy()]) {
            try {
              duty();
            } catch (failure) {
              retain(failure);
            }
          }
        };
        const responseLost = () => {
          if (!res.writableFinished) lost();
        };
        const removeRequest = req.removeListener.bind(req);
        cleanup.push(() => removeRequest('aborted', lost));
        const removeResponse = res.removeListener.bind(res);
        cleanup.push(() => removeResponse('close', responseLost));
        cleanup.push(() => cancellations.delete(lost));
        // Removal duties exist before reading or entering either listener producer.
        const onceRequest = req.once.bind(req),
          onceResponse = res.once.bind(res);
        cancellations.add(lost);
        requireAvailable();
        if (gone) throw refusal('CLOSED');
        onceRequest('aborted', lost);
        requireAvailable();
        if (gone) throw refusal('CLOSED');
        onceResponse('close', responseLost);
        requireAvailable();
        if (gone) throw refusal('CLOSED');
        const publish = (bytes: Buffer): Promise<void> => {
          let resolve!: () => void, reject!: (reason: unknown) => void;
          publication = new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
          });
          rejectPublication = reject;
          void publication.catch(() => {});
          let returned!: () => void;
          const callbackOriginal = new Promise<void>((yes) => {
            returned = yes;
          });
          // Cancellation can fence publication, but never settle the actual writable callback join.
          try {
            originalEnd(bytes, (reason?: unknown) => {
              if (reason !== undefined) {
                retain(reason);
                reject(reason);
              } else resolve();
              returned();
            });
          } catch (reason) {
            retain(reason);
            reject(reason);
            returned();
          }
          return Promise.allSettled([publication, callbackOriginal]).then((results) => {
            for (const result of results) if (result.status === 'rejected') throw result.reason;
          });
        };
        void Promise.resolve()
          .then(async () => {
            try {
              // Local origin denial shares the owned bounded response/callback completion path.
              requireAvailable();
              const enteredOrigin = origin(req);
              requireAvailable();
              const ownerInput = { cookie: req.headers.cookie };
              requireAvailable();
              const actorCurrent = await captureOwner(ownerInput, abort.signal);
              requireAvailable();
              if (gone || !actorCurrent()) throw refusal('AUTHORITY_REFUSED');
              requireAvailable();
              const result = await operation(req, res, abort.signal);
              requireAvailable();
              const bytes = Buffer.from(JSON.stringify(result));
              res.status(200).type('application/json');
              // Original request/response observations finish before the final captured actor fence.
              const sameOrigin = origin(req) === enteredOrigin;
              const outputUnavailable = req.aborted || res.destroyed || res.writableEnded;
              if (
                !sameOrigin ||
                outputUnavailable ||
                !actorCurrent() ||
                !responseCanPublish(req, res) ||
                closed ||
                first ||
                gone ||
                abort.signal.aborted
              )
                throw refusal('AUTHORITY_REFUSED');
              await publish(bytes);
            } catch (reason) {
              const canReportFailure = first === undefined;
              if (
                !(typeof reason === 'object' && reason !== null && localDenials.has(reason)) &&
                !expectedModeRefusal(reason)
              )
                retain(reason);
              if (navigationOperation) navigationDiagnostic.failure(reason);
              try {
                originalAbort(reason);
              } catch (failure) {
                retain(failure);
              }
              // Report this operation's first failure, but never publish for later fenced work.
              if (canReportFailure && !gone && !closed && !res.destroyed && !res.writableEnded) {
                try {
                  res.status(reason instanceof z.ZodError ? 400 : 503).type('application/json');
                  await publish(
                    Buffer.from(
                      JSON.stringify({
                        error:
                          reason instanceof z.ZodError
                            ? 'Browser request couldn’t be read.'
                            : 'The shared browser needs a verified installation and a signed-in owner.',
                      })
                    )
                  );
                } catch (failure) {
                  // Our cancellation fences output, but the original writable callback is still
                  // joined by publish(). Callback/end failures already retain their exact cause.
                  if (!(
                    typeof failure === 'object' &&
                    failure !== null &&
                    localDenials.has(failure)
                  ))
                    retain(failure);
                }
              }
            }
            await finish();
          })
          .then(resolveOriginal, rejectOriginal);
      } catch (reason) {
        retain(reason);
        // A throwing registration cannot bypass any already captured original remover.
        void finish().then(resolveOriginal, rejectOriginal);
      }
    };
  router.post(
    '/runtime/local-destination',
    handle(async (req, _res, signal) => {
      const input = parseInput(BrowserLocalDestinationRequestSchema, req.body);
      requireAvailable();
      return BrowserLocalDestinationReceiptSchema.parse(
        await mode.allowLocalDestination(
          { cookie: req.headers.cookie },
          input,
          signal,
          (original) => localDenials.add(original)
        )
      );
    })
  );
  router.post(
    '/runtime/profiles/import',
    handle(async (req, _res, signal) => {
      const request = parseInput(BrowserProductionProfileImportRequestSchema, req.body);
      requireAvailable();
      return BrowserProductionProfileImportReceiptSchema.parse(
        await mode.importProfile({ cookie: req.headers.cookie }, request, signal)
      );
    })
  );
  router.post(
    '/runtime/profiles',
    handle(async (req, _res, signal) => {
      const request = parseInput(BrowserProductionProfileCreateRequestSchema, req.body);
      requireAvailable();
      return BrowserProductionProfileCreateReceiptSchema.parse(
        await mode.createProfile({ cookie: req.headers.cookie }, request, signal)
      );
    })
  );
  router.post(
    '/runtime/navigate',
    handle(async (req, res, signal) => {
      const { command, controllerId } = parseInput(
        BrowserProductionNavigateRequestSchema,
        req.body
      );
      requireAvailable();
      const original = mode.originalForBinding(command.binding);
      const binding = await original
        .navigation()
        .capture(req, res)
        .navigate(command, controllerId, undefined, signal);
      return BrowserProductionNavigateReceiptSchema.parse({
        requestId: command.requestId,
        binding,
      });
    }, true)
  );
  router.post(
    '/runtime/open',
    handle(async (req, _res, signal) => {
      const command = parseInput(BrowserProductionOpenRequestSchema, req.body);
      requireAvailable();
      const { result } = await mode.open(
        { cookie: req.headers.cookie },
        command.workspaceId,
        command.request,
        signal,
        command.initialUrl
      );
      return BrowserProductionOpenReceiptSchema.parse({
        requestId: command.request.requestId,
        instance: result.instance,
        binding: result.binding,
      });
    })
  );
  router.post(
    '/workspaces/:workspaceId/open',
    handle(async (req, _res, signal) => {
      const workspaceId = parseInput(BrowserReferenceSchema, req.params.workspaceId);
      const command = parseInput(BrowserOpenRequestSchema, req.body);
      requireAvailable();
      const { result } = await mode.open(
        { cookie: req.headers.cookie },
        workspaceId,
        command,
        signal
      );
      return BrowserInstanceSchema.parse(result.instance);
    })
  );
  router.post(
    '/instances/close',
    handle(async (req, _res, signal) => {
      const command = parseInput(BrowserCloseRequestSchema, req.body);
      requireAvailable();
      await mode.closeBrowser(
        { cookie: req.headers.cookie },
        command.browserId,
        command.browserGeneration,
        signal
      );
      return BrowserCloseReceiptSchema.parse({
        ...command,
        cleanup: 'observed',
      });
    })
  );
  router.post(
    '/navigate',
    handle(async (req, res, signal) => {
      const command = parseInput(BrowserNavigateRequestSchema, req.body);
      const controllerId = parseInput(
        BrowserReferenceSchema,
        req.headers['x-browser-controller-id']
      );
      requireAvailable();
      const original = mode.originalForBinding(command.binding);
      const binding = await original
        .navigation()
        .capture(req, res)
        .navigate(command, controllerId, undefined, signal);
      return BrowserBindingSchema.parse(binding);
    }, true)
  );
  router.post(
    '/control',
    handle(async (req, res) => {
      const binding = parseInput(BrowserBindingSchema, req.body);
      requireAvailable();
      const original = mode.originalForBinding(binding);
      return BrowserControlSchema.parse(
        await original.controller().capture(req, res).takeover(binding)
      );
    })
  );
  router.get(
    '/:browserId/tabs',
    handle(async (req, _res, signal) => {
      const browserId = parseInput(BrowserReferenceSchema, req.params.browserId);
      const generationQuery = z
        .object({
          browserGeneration: z
            .string()
            .regex(/^(0|[1-9]\d*)$/)
            .transform(Number)
            .pipe(BrowserCounterSchema),
        })
        .strict();
      const { browserGeneration } = parseInput(generationQuery, req.query);
      requireAvailable();
      const original = mode.originalForBinding({
        browserId,
        browserGeneration,
      });
      const ownerInput = { cookie: req.headers.cookie };
      requireAvailable();
      const actorCurrent = await captureOwner(ownerInput, signal);
      requireAvailable();
      const credential = Object.freeze({ current: actorCurrent });
      const actor = () =>
        actorCurrent() ? { owner: actorCurrent.ownerId, credential } : undefined;
      const bindings = await original.bindings(actor, browserId, browserGeneration);
      if (!original.current() || !actorCurrent()) throw refusal('AUTHORITY_REFUSED');
      return z.array(BrowserBindingSchema).max(64).parse(bindings);
    })
  );
  // Select only a genuine existing session; every child host independently authenticates
  // the original request and checks its exact binding/grant before any effect or publication.
  const semanticPaths = ['read', 'action', 'stream', 'next', 'close'].flatMap((kind) => [
    `/semantic/${kind}`,
    `/semantic/owner/${kind}`,
  ]);
  router.post(
    [
      ...semanticPaths,
      '/diagnostics',
      '/canvas/present',
      ...['grant', 'revoke', 'stage', 'upload', 'download', 'read'].map((kind) => '/files/' + kind),
    ],
    (req, res, next) => {
      try {
        const binding = BrowserBindingSchema.parse(req.body?.binding);
        requireAvailable();
        const original = mode.originalForBinding(binding);
        const dispatch = Reflect.apply(originalFunctionBind, original.router, [original]);
        requireAvailable();
        dispatch(req, res, next);
      } catch {
        res.status(404).json({ error: 'Browser resource not found' });
      }
    }
  );
  router.post(['/canvas/share', '/canvas/delivery', '/canvas/detach'], (req, res, next) => {
    try {
      const attachmentId = BrowserReferenceSchema.parse(req.body?.attachmentId);
      requireAvailable();
      const original = mode.originalForAttachment(attachmentId);
      const dispatch = Reflect.apply(originalFunctionBind, original.router, [original]);
      requireAvailable();
      dispatch(req, res, next);
    } catch {
      res.status(404).json({ error: 'Browser resource not found' });
    }
  });
  router.post(['/viewers/issue', '/input', '/copy-selection'], (req, res, next) => {
    let stage: BrowserViewerDiagnosticStage = 'router.binding-parse';
    try {
      const binding = BrowserBindingSchema.parse(req.body?.binding ?? req.body?.command?.binding);
      requireAvailable();
      stage = 'router.binding-select';
      const original = mode.originalForBinding(binding);
      const dispatch = Reflect.apply(originalFunctionBind, original.router, [original]);
      requireAvailable();
      stage = 'router.binding-dispatch';
      dispatch(req, res, next);
    } catch (value) {
      viewerDiagnostic.failure(stage, value);
      res.status(404).json({ error: 'Browser resource not found' });
    }
  });
  router.post(['/viewers/next', '/viewers/disconnect'], (req, res, next) => {
    let stage: BrowserViewerDiagnosticStage = 'router.ticket-parse';
    try {
      const ticket = z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/u)
        .parse(req.body?.ticket);
      requireAvailable();
      stage = 'router.ticket-select';
      const original = mode.originalForTicket(ticket);
      const dispatch = Reflect.apply(originalFunctionBind, original.router, [original]);
      requireAvailable();
      stage = 'router.ticket-dispatch';
      dispatch(req, res, next);
    } catch (value) {
      viewerDiagnostic.failure(stage, value);
      res.status(404).json({ error: 'Browser resource not found' });
    }
  });
  router.use(
    createBrowserRouter(
      new BrowserApiService(mode.registry, mode.store, () => {
        if (closed || first) return false;
        const current = modeCurrent();
        return !closed && !first && current;
      })
    )
  );
  return Object.freeze({
    router,
    close(): Promise<void> {
      if (closing) return closing;
      let resolve!: () => void, reject!: (reason: unknown) => void;
      closing = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      closed = true;
      for (const cancellation of cancellations) {
        try {
          cancellation();
        } catch (reason) {
          fail(reason);
        }
      }
      const jobs: Promise<unknown>[] = [];
      try {
        jobs.push(closeMode());
      } catch (reason) {
        fail(reason);
      }
      jobs.push(...work);
      void Promise.allSettled(jobs).then((results) => {
        for (const result of results) if (result.status === 'rejected') fail(result.reason);
        if (first) reject(first.reason);
        else resolve();
      });
      return closing;
    },
  });
}
