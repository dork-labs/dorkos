import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  BrowserProductionEnableRequestSchema,
  BrowserProductionStatusSchema,
  type BrowserProductionStatus,
} from '@dorkos/shared/browser-schemas';
import { resolveBrowserOriginFacts } from '../../../../middleware/browser-origin.js';
import { isTrustedBrowserOrigin } from '../../../../lib/trusted-origins.js';
const descriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.prototype.hasOwnProperty;
const own = (object: object, key: string) => {
  const field = descriptor(object, key);
  return field && Reflect.apply(hasOwn, field, ['value']) ? field.value : undefined;
};
/** Persistent owner-only Off/On facade; no native or runtime module is imported here. */
export function createBrowserActivationRoutes(owner: {
  authenticate(cookie: string | undefined, signal: AbortSignal): Promise<() => boolean>;
  enable(
    enabled: boolean,
    cookie: string | undefined,
    signal: AbortSignal,
    chromeUserAgent?: boolean
  ): Promise<BrowserProductionStatus>;
  status(cookie: string | undefined, signal: AbortSignal): Promise<BrowserProductionStatus>;
  expected(reason: unknown): boolean;
}) {
  const authenticate = owner.authenticate.bind(owner),
    enable = owner.enable.bind(owner),
    status = owner.status.bind(owner),
    expected = owner.expected.bind(owner);
  const router = Router(),
    originals = new Set<Promise<void>>(),
    fences = new Set<() => void>();
  let closed = false,
    closing: Promise<void> | undefined,
    failure: Readonly<{ value: unknown }> | undefined;
  const fail = (value: unknown) => {
    failure ??= { value };
  };
  const malformed = new WeakSet<object>(),
    localDenials = new WeakSet<object>();
  const refusal = (code: string) => {
    const reason = new Error(code);
    localDenials.add(reason);
    return reason;
  };
  const local = (value: unknown) =>
    typeof value === 'object' &&
    value !== null &&
    (malformed.has(value) || localDenials.has(value));
  const parseInput = (value: unknown) => {
    try {
      return BrowserProductionEnableRequestSchema.parse(value);
    } catch (reason) {
      if (reason instanceof z.ZodError) malformed.add(reason);
      throw reason;
    }
  };
  const handler = (changing: boolean) => (req: Request, res: Response) => {
    if (closed || failure || originals.size >= 16) {
      res.status(503).json({ error: 'Shared browser is unavailable.' });
      return;
    }
    let yes!: () => void, no!: (value: unknown) => void;
    const whole = new Promise<void>((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    originals.add(whole);
    void whole.then(
      () => originals.delete(whole),
      (value) => {
        fail(value);
        originals.delete(whole);
      }
    );
    const removers: (() => unknown)[] = [];
    let primary: Readonly<{ value: unknown }> | undefined;
    const retain = (value: unknown) => {
      primary ??= { value };
      fail(value);
    };
    const finish = async () => {
      for (const remove of removers) {
        try {
          await remove();
        } catch (value) {
          retain(value);
        }
      }
      if (primary) throw primary.value;
    };
    try {
      const end = res.end.bind(res),
        destroy = res.destroy.bind(res),
        controller = new AbortController(),
        abort = controller.abort.bind(controller);
      let gone = req.aborted || res.destroyed;
      const cancel = () => {
        gone = true;
        for (const duty of [abort, destroy]) {
          try {
            duty();
          } catch (value) {
            retain(value);
          }
        }
      };
      const onClose = () => {
        try {
          if (!res.writableFinished) cancel();
        } catch (value) {
          retain(value);
          cancel();
        }
      };
      const reqOff = req.removeListener.bind(req);
      removers.push(() => reqOff('aborted', cancel));
      const resOff = res.removeListener.bind(res);
      removers.push(() => resOff('close', onClose));
      removers.push(() => fences.delete(cancel));
      const reqOn = req.once.bind(req),
        resOn = res.once.bind(res);
      fences.add(cancel);
      if (closed || gone) throw refusal('ACTIVATION_CLOSED');
      reqOn('aborted', cancel);
      if (closed || gone) throw refusal('ACTIVATION_CLOSED');
      resOn('close', onClose);
      if (closed || gone) throw refusal('ACTIVATION_CLOSED');
      const admitOriginal = () => {
        if (failure) throw failure.value;
        if (closed || gone || controller.signal.aborted) throw refusal('ACTIVATION_CLOSED');
      };
      const publish = (value: unknown, successful = false) => {
        if (successful) admitOriginal();
        let resolve!: () => void;
        const originalCallback = new Promise<void>((yes) => {
          resolve = yes;
        });
        try {
          end(Buffer.from(JSON.stringify(value)), (value?: unknown) => {
            if (value !== undefined) retain(value);
            resolve();
          });
        } catch (value) {
          retain(value);
          resolve();
        }
        return originalCallback;
      };
      void Promise.resolve()
        .then(async () => {
          try {
            const facts = resolveBrowserOriginFacts(req, { hostCheckInert: false });
            if (
              !facts.hostAllowed ||
              (changing && !facts.origin) ||
              !isTrustedBrowserOrigin(facts, {
                allowNoOrigin: !changing,
                pairSameOriginWithHost: true,
              })
            ) {
              res.status(403).type('application/json');
              await publish({ error: 'Shared browser request was refused.' });
              return;
            }
            const cookie = req.headers.cookie;
            admitOriginal();
            const actor = await authenticate(cookie, controller.signal);
            admitOriginal();
            const choice = changing ? parseInput(req.body) : undefined;
            const enabled = choice?.enabled;
            admitOriginal();
            const result = changing
              ? choice?.chromeUserAgent === undefined
                ? await enable(enabled!, cookie, controller.signal)
                : await enable(false, cookie, controller.signal, choice.chromeUserAgent)
              : await status(cookie, controller.signal);
            admitOriginal();
            const bytes = BrowserProductionStatusSchema.parse(result);
            res.status(200).type('application/json');
            const finalFacts = resolveBrowserOriginFacts(req, { hostCheckInert: false });
            if (
              finalFacts.origin !== facts.origin ||
              !finalFacts.hostAllowed ||
              !isTrustedBrowserOrigin(finalFacts, {
                allowNoOrigin: !changing,
                pairSameOriginWithHost: true,
              }) ||
              !actor() ||
              own(req, 'aborted') !== false ||
              own(res, 'destroyed') !== false ||
              own(res, 'finished') !== false ||
              own(res, 'writable') !== true ||
              own(res, 'statusCode') !== 200 ||
              failure ||
              closed ||
              gone ||
              controller.signal.aborted
            )
              throw refusal('ACTIVATION_PUBLICATION_REFUSED');
            await publish(bytes, true);
          } catch (value) {
            if (!expected(value) && !local(value)) retain(value);
            try {
              abort(value);
            } catch (failure) {
              retain(failure);
            }
            if (!closed && !gone && !res.destroyed && !res.writableEnded) {
              try {
                res.status(503).type('application/json');
                await publish({
                  error: 'Shared browser could not be changed. Refresh before trying again.',
                });
              } catch (failure) {
                retain(failure);
              }
            }
          }
        })
        .then(finish, (value) => {
          retain(value);
          return finish();
        })
        .then(yes, no);
    } catch (value) {
      if (!local(value)) retain(value);
      void finish().then(yes, no);
    }
  };
  router.get('/runtime/status', handler(false));
  router.post('/runtime/enable', handler(true));
  return Object.freeze({
    router,
    close(): Promise<void> {
      if (closing) return closing;
      let yes!: () => void, no!: (value: unknown) => void;
      closing = new Promise<void>((resolve, reject) => {
        yes = resolve;
        no = reject;
      });
      closed = true;
      for (const fence of fences) {
        try {
          fence();
        } catch (value) {
          fail(value);
        }
      }
      void Promise.allSettled([...originals]).then((results) => {
        for (const result of results) if (result.status === 'rejected') fail(result.reason);
        if (failure) no(failure.value);
        else yes();
      });
      return closing;
    },
  });
}
