import { Router, type Request, type Response } from 'express';
import {
  BrowserCanvasPresentSchema,
  BrowserCanvasShareSchema,
  BrowserCanvasDeliverySchema,
  BrowserCanvasDetachSchema,
} from '@dorkos/shared/browser-canvas-schemas';
import { BrowserApiRefusal } from './service.js';
import type { BrowserControllerIdentities } from './controller-auth.js';
import type {
  BrowserCanvasAttachmentHost,
  BrowserCanvasAdmission,
} from './canvas-attachment-host.js';
import { resolveBrowserOriginFacts } from '../../../middleware/browser-origin.js';
import { isTrustedBrowserOrigin } from '../../../lib/trusted-origins.js';

/** Authenticated constructor-owned canvas commands; document JSON supplies no permission. */
export class BrowserCanvasAttachmentRoutes {
  readonly router = Router();
  private readonly originals = new Set<Promise<void>>();
  private closed = false;
  private closing?: Promise<void>;
  private first?: Readonly<{ value: unknown }>;
  private readonly capture: BrowserControllerIdentities['capture'];
  private readonly present: BrowserCanvasAttachmentHost['present'];
  private readonly share: BrowserCanvasAttachmentHost['share'];
  private readonly delivery: BrowserCanvasAttachmentHost['delivery'];
  private readonly detach: BrowserCanvasAttachmentHost['detachPresentation'];
  private readonly faulted: BrowserCanvasAttachmentHost['faulted'];
  private readonly publicationCurrent: BrowserCanvasAttachmentHost['publicationCurrent'];

  constructor(
    host: BrowserCanvasAttachmentHost,
    identities: BrowserControllerIdentities,
    private readonly enabled: () => boolean
  ) {
    this.capture = identities.capture.bind(identities);
    this.present = host.present.bind(host);
    this.share = host.share.bind(host);
    this.delivery = host.delivery.bind(host);
    this.detach = host.detachPresentation.bind(host);
    this.faulted = host.faulted.bind(host);
    this.publicationCurrent = host.publicationCurrent.bind(host);
    for (const kind of ['present', 'share', 'delivery', 'detach'] as const)
      this.router.post(`/canvas/${kind}`, (req, res) => {
        if (this.closed || this.first || this.originals.size >= 16) {
          res.status(503).end();
          return;
        }
        const original = Promise.resolve().then(() => this.respond(req, res, kind));
        this.originals.add(original);
        void original.then(
          () => this.originals.delete(original),
          (reason) => {
            this.first ??= { value: reason };
            this.originals.delete(original);
          }
        );
      });
  }
  private async respond(
    req: Request,
    res: Response,
    kind: 'present' | 'share' | 'delivery' | 'detach'
  ) {
    if (this.closed || this.first) return;
    const denials = new Set<unknown>();
    let delegated = false,
      publication = false;
    try {
      if (!this.enabled()) {
        res.status(503).end();
        return;
      }
      const origin = () => {
        const facts = resolveBrowserOriginFacts(req, { hostCheckInert: false });
        return req.method === 'POST' &&
          facts.hostAllowed &&
          !!facts.origin &&
          isTrustedBrowserOrigin(facts, {
            allowNoOrigin: false,
            pairSameOriginWithHost: true,
          })
          ? facts.origin
          : undefined;
      };
      const admittedOrigin = origin();
      if (!admittedOrigin) {
        res.status(403).end();
        return;
      }
      const body = req.body;
      const admission: { value?: BrowserCanvasAdmission } = {};
      const acquire = (mark: (value: unknown) => void) => {
        const actual = this.capture(req, res, undefined, (value) => {
          denials.add(value);
          mark(value);
        });
        const refresh = actual.refresh.bind(actual),
          current = actual.current.bind(actual);
        const requestCurrent = () => {
          const descriptor = Object.getOwnPropertyDescriptor(req, 'aborted');
          return (
            !this.closed &&
            !this.first &&
            !!descriptor &&
            'value' in descriptor &&
            descriptor.value === false
          );
        };
        const captured = {
          refresh: async () => {
            const actor = await refresh();
            if (!requestCurrent()) {
              const refusal = new BrowserApiRefusal('inaccessible');
              denials.add(refusal);
              mark(refusal);
              throw refusal;
            }
            return actor;
          },
          current: () => {
            const actor = current();
            return requestCurrent() ? actor : undefined;
          },
        };
        admission.value = captured;
        return captured;
      };
      let attachmentId: string | undefined;
      let original: Promise<unknown>;
      if (kind === 'present') {
        const parsed = BrowserCanvasPresentSchema.safeParse(body);
        if (!parsed.success) {
          res.status(400).end();
          return;
        }
        const value = parsed.data;
        original = this.present(acquire, value.binding, value.target);
      } else if (kind === 'share') {
        const parsed = BrowserCanvasShareSchema.safeParse(body);
        if (!parsed.success) {
          res.status(400).end();
          return;
        }
        const value = parsed.data;
        attachmentId = value.attachmentId;
        original = this.share(
          acquire,
          value.attachmentId,
          value.recipient,
          value.permissions,
          value.expiresAt
        );
      } else if (kind === 'delivery') {
        const parsed = BrowserCanvasDeliverySchema.safeParse(body);
        if (!parsed.success) {
          res.status(400).end();
          return;
        }
        const value = parsed.data;
        attachmentId = value.attachmentId;
        original = this.delivery(acquire, value.attachmentId, value.grant);
      } else {
        const parsed = BrowserCanvasDetachSchema.safeParse(body);
        if (!parsed.success) {
          res.status(400).end();
          return;
        }
        const value = parsed.data;
        original = this.detach(acquire, value.attachmentId).then(() => ({}));
      }
      delegated = true;
      const value = await original;
      publication = true;
      const captured = admission.value;
      const enteredActor = captured?.current();
      if (!captured || !enteredActor) {
        res.status(403).end();
        return;
      }
      const fresh = await captured.refresh();
      if (fresh.owner !== enteredActor.owner || fresh.credential !== enteredActor.credential) {
        res.status(403).end();
        return;
      }
      if (!this.enabled() || this.closed || this.first) {
        res.status(503).end();
        return;
      }
      // The final wire fence reads actual Node data; no app property getter runs after authority.
      const data = (object: object, key: string) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor && 'value' in descriptor ? descriptor.value : undefined;
      };
      const status = res.status.bind(res),
        end = res.end.bind(res),
        type = res.type.bind(res);
      const bytes = JSON.stringify(value);
      type('application/json');
      status(200);
      if (!this.enabled() || origin() !== admittedOrigin) {
        status(403);
        end();
        return;
      }
      let grant: { grantId: string; revision: number } | undefined;
      if (kind === 'present') {
        const document = value as Awaited<ReturnType<BrowserCanvasAttachmentHost['present']>>;
        if (document.content.type === 'managed_browser')
          attachmentId = document.content.attachmentId;
      } else if (kind === 'delivery') {
        grant = (value as Awaited<ReturnType<BrowserCanvasAttachmentHost['delivery']>>).grant;
      }
      const current = captured.current();
      if (
        !current ||
        current.owner !== fresh.owner ||
        current.credential !== fresh.credential ||
        (kind !== 'detach' &&
          (!attachmentId || !this.publicationCurrent(attachmentId, current.owner, grant)))
      ) {
        status(403);
        end();
        return;
      }
      if (
        this.closed ||
        this.first ||
        data(req, 'aborted') !== false ||
        data(res, 'destroyed') !== false ||
        data(res, 'finished') !== false ||
        data(res, 'writable') !== true ||
        data(res, 'statusCode') !== 200
      ) {
        const destroy = res.destroy.bind(res);
        destroy();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        try {
          end(bytes, (reason?: Error | null) =>
            reason !== undefined && reason !== null ? reject(reason) : resolve()
          );
        } catch (reason) {
          reject(reason);
        }
      });
    } catch (reason) {
      if ((!delegated || publication || this.faulted()) && !denials.has(reason))
        this.first ??= { value: reason };
      if (!res.destroyed && !res.finished) res.status(this.first ? 503 : 403).end();
    }
  }
  close(): Promise<void> {
    this.closed = true;
    return (this.closing ??= Promise.resolve().then(async () => {
      for (const result of await Promise.allSettled([...this.originals]))
        if (result.status === 'rejected') this.first ??= { value: result.reason };
      if (this.first) throw this.first.value;
    }));
  }
}
