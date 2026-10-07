import { Router, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import {
  BrowserBindingSchema,
  BrowserHumanGrantRequestSchema,
  BrowserHumanGrantRevokeSchema,
  BrowserHumanStageRequestSchema,
  BrowserHumanStageReceiptSchema,
  BrowserHumanUploadRequestSchema,
  BrowserHumanDownloadRequestSchema,
  BrowserHumanDownloadReceiptSchema,
  BrowserHumanArtifactReadRequestSchema,
  BrowserHumanArtifactReceiptSchema,
  BrowserGrantSchema,
  type BrowserPermission,
} from '@dorkos/shared/browser-schemas';
import { resolveBrowserOriginFacts } from '../../../middleware/browser-origin.js';
import { isTrustedBrowserOrigin } from '../../../lib/trusted-origins.js';
import {
  isOriginalBrowserIdentityRefusal,
  type BrowserControllerIdentities,
} from './controller-auth.js';
import { isOriginalBrowserGrantRefusal, type OwnedBrowserGrants } from './grants.js';
import type { BrowserControllerUpload } from './controller-upload.js';
import type { BrowserControllerDownload } from './controller-download.js';
import type { BrowserUploadArtifacts } from './files/upload-artifacts.js';
import { projectBrowserActionReceipt } from './action-receipt.js';
import { browserFileRefusal, isOriginalBrowserFileRefusal } from './files/file-refusal.js';

type Reference = Readonly<{ grantId: string; revision: number }>;
const originalDescriptor = Object.getOwnPropertyDescriptor;
const ownData = (owner: object, key: string) => {
  const descriptor = originalDescriptor(owner, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
/** Human-cookie file API. Every original host still checks its independent native step authority. */
export class BrowserHumanFileRoutes {
  readonly router = Router();
  private readonly capture: BrowserControllerIdentities['capture'];
  private readonly admit: OwnedBrowserGrants['admit'];
  private readonly issue: OwnedBrowserGrants['issue'];
  private readonly revoke: OwnedBrowserGrants['revoke'];
  private readonly stage: BrowserControllerUpload['stage'];
  private readonly upload: BrowserControllerUpload['upload'];
  private readonly download: BrowserControllerDownload['download'];
  private readonly read: BrowserUploadArtifacts['read'];
  private readonly work = new Set<Promise<void>>();
  private readonly cancels = new Set<() => void>();
  private readonly malformed = new WeakSet<object>();
  private first?: Readonly<{ value: unknown }>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    upload: BrowserControllerUpload,
    download: BrowserControllerDownload,
    artifacts: BrowserUploadArtifacts,
    identities: BrowserControllerIdentities,
    grants: OwnedBrowserGrants,
    private readonly enabled: () => boolean
  ) {
    this.capture = identities.capture.bind(identities);
    this.admit = grants.admit.bind(grants);
    this.issue = grants.issue.bind(grants);
    this.revoke = grants.revoke.bind(grants);
    this.stage = upload.stage.bind(upload);
    this.upload = upload.upload.bind(upload);
    this.download = download.download.bind(download);
    this.read = artifacts.read.bind(artifacts);
    for (const kind of ['grant', 'revoke', 'stage', 'upload', 'download', 'read'] as const)
      this.router.post('/files/' + kind, (req, res) => {
        if (this.closed || this.first || this.work.size >= 16) {
          try {
            res.status(503).json({ error: 'Shared browser is unavailable.' });
          } catch (value) {
            this.first ??= { value };
            try {
              res.destroy();
            } catch (cleanup) {
              this.first ??= { value: cleanup };
            }
          }
          return;
        }
        const original = Promise.resolve().then(() => this.respond(kind, req, res));
        this.work.add(original);
        void original.then(
          () => this.work.delete(original),
          (value) => {
            if (!(this.closed && isOriginalBrowserFileRefusal(value))) this.first ??= { value };
            try {
              res.destroy();
            } catch (cleanup) {
              this.first ??= { value: cleanup };
            }
            this.work.delete(original);
          }
        );
      });
  }
  private check() {
    if (this.first) throw this.first.value;
    if (this.closed || !this.enabled() || this.closed) throw browserFileRefusal('unavailable');
  }
  private parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
    try {
      return schema.parse(input);
    } catch (value) {
      if (value instanceof ZodError) this.malformed.add(value);
      throw value;
    }
  }
  private origin(req: Request): string {
    this.check();
    const facts = resolveBrowserOriginFacts(req, { hostCheckInert: false });
    if (
      req.method !== 'POST' ||
      !facts.origin ||
      !facts.hostAllowed ||
      !isTrustedBrowserOrigin(facts, { allowNoOrigin: false, pairSameOriginWithHost: true })
    )
      throw browserFileRefusal('inaccessible');
    this.check();
    return facts.origin;
  }
  private async respond(
    kind: 'grant' | 'revoke' | 'stage' | 'upload' | 'download' | 'read',
    req: Request,
    res: Response
  ) {
    this.check();
    const controller = new AbortController();
    const send = res.end.bind(res),
      header = res.setHeader.bind(res),
      reqOn = req.on.bind(req),
      reqOff = req.off.bind(req),
      resOn = res.on.bind(res),
      resOff = res.off.bind(res);
    let gone = this.closed || req.aborted || res.destroyed;
    const cancel = () => {
      gone = true;
      try {
        controller.abort(browserFileRefusal('inaccessible'));
      } catch (value) {
        this.first ??= { value };
      }
    };
    this.cancels.add(cancel);
    let bytes: Buffer | undefined;
    try {
      reqOn('aborted', cancel);
      resOn('close', cancel);
      this.check();
      if (gone) cancel();
      const body = req.body;
      const binding = this.parse(BrowserBindingSchema, body?.binding);
      const origin = this.origin(req);
      const auth = this.capture(req, res);
      const actor = await auth.refresh();
      const check = (grants: readonly [Reference, BrowserPermission][] = []) => {
        this.check();
        controller.signal.throwIfAborted();
        if (gone || this.origin(req) !== origin) throw browserFileRefusal('inaccessible');
        for (const [reference, permission] of grants)
          this.admit(auth.current, reference.grantId, reference.revision, binding, permission);
        const current = auth.current();
        if (!current || current.owner !== actor.owner || current.credential !== actor.credential)
          throw browserFileRefusal('inaccessible');
        this.check();
        controller.signal.throwIfAborted();
        return true;
      };
      check();
      let result: unknown;
      let permissions: readonly [Reference, BrowserPermission][] = [];
      if (kind === 'grant') {
        const request = this.parse(BrowserHumanGrantRequestSchema, body);
        result = BrowserGrantSchema.parse(
          this.issue(
            auth.current,
            binding,
            actor.owner,
            request.attachment,
            request.permissions,
            new Date(Date.now() + request.expiresInMs).toISOString()
          )
        );
      } else if (kind === 'revoke') {
        const request = this.parse(BrowserHumanGrantRevokeSchema, body);
        this.admit(
          auth.current,
          request.grant.grantId,
          request.grant.revision,
          binding,
          request.permission
        );
        result = BrowserGrantSchema.parse(
          this.revoke(auth.current, request.grant.grantId, request.grant.revision)
        );
      } else if (kind === 'stage') {
        const request = this.parse(BrowserHumanStageRequestSchema, body);
        bytes = Buffer.from(request.base64, 'base64');
        if (!bytes.length || bytes.length > 524288 || bytes.toString('base64') !== request.base64)
          throw browserFileRefusal('inaccessible');
        permissions = [[request.artifactGrant, 'browser.artifact']];
        check(permissions);
        result = BrowserHumanStageReceiptSchema.parse(
          await this.stage(
            req,
            res,
            binding,
            request.artifactGrant,
            request.name,
            request.mimeType,
            bytes,
            controller.signal
          )
        );
      } else if (kind === 'upload') {
        const request = this.parse(BrowserHumanUploadRequestSchema, body);
        permissions = [
          [request.artifactGrant, 'browser.artifact'],
          [request.transferGrant, 'browser.upload'],
        ];
        check(permissions);
        result = projectBrowserActionReceipt(
          await this.upload(
            req,
            res,
            request.command,
            request.controllerId,
            request.artifactGrant,
            request.transferGrant,
            request.controlGrant,
            controller.signal
          )
        );
      } else if (kind === 'download') {
        const request = this.parse(BrowserHumanDownloadRequestSchema, body);
        permissions = [
          [request.artifactGrant, 'browser.artifact'],
          [request.transferGrant, 'browser.download'],
        ];
        check(permissions);
        const original = await this.download(
          req,
          res,
          request.command,
          request.controllerId,
          request.artifactGrant,
          request.transferGrant,
          request.controlGrant,
          controller.signal
        );
        result = BrowserHumanDownloadReceiptSchema.parse({
          input: projectBrowserActionReceipt(original.input),
          artifact: original.artifact,
        });
      } else {
        const request = this.parse(BrowserHumanArtifactReadRequestSchema, body);
        permissions = [[request.artifactGrant, 'browser.artifact']];
        check(permissions);
        const original = await this.read(
          actor,
          binding,
          request.artifactId,
          () => check(permissions),
          controller.signal
        );
        bytes = original.bytes;
        result = BrowserHumanArtifactReceiptSchema.parse({
          artifactId: original.artifactId,
          byteLength: original.byteLength,
          name: original.name,
          mimeType: original.mimeType,
          base64: bytes.toString('base64'),
        });
      }
      await auth.refresh();
      check(permissions);
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized) > 2820000) throw browserFileRefusal('unavailable');
      header('Content-Type', 'application/json; charset=utf-8');
      header('Cache-Control', 'no-store');
      res.status(200);
      check(permissions);
      if (
        ownData(res, 'statusCode') !== 200 ||
        ownData(req, 'aborted') !== false ||
        ownData(res, 'destroyed') !== false ||
        ownData(res, 'finished') !== false ||
        ownData(res, 'writable') !== true
      )
        throw browserFileRefusal('inaccessible');
      // Retain the actual original writable return; cancellation never fabricates its callback.
      await new Promise<void>((resolve, reject) => {
        send(serialized, (error?: Error | null) => {
          if (error !== undefined && error !== null) reject(error);
          else resolve();
        });
      });
    } catch (value) {
      const malformed = !!value && typeof value === 'object' && this.malformed.has(value);
      const denied =
        isOriginalBrowserFileRefusal(value) ||
        isOriginalBrowserIdentityRefusal(value) ||
        isOriginalBrowserGrantRefusal(value);
      if (!malformed && !denied) this.first ??= { value };
      if (!gone && !this.closed)
        res.status(malformed ? 400 : denied ? 404 : 503).json({
          error: malformed
            ? 'Browser request couldn’t be read.'
            : denied
              ? 'Shared browser is unavailable.'
              : 'The file operation couldn’t be confirmed.',
        });
    } finally {
      bytes?.fill(0);
      for (const cleanup of [() => reqOff('aborted', cancel), () => resOff('close', cancel)]) {
        try {
          cleanup();
        } catch (value) {
          this.first ??= { value };
        }
      }
      this.cancels.delete(cancel);
    }
  }
  /** Fence publication immediately, then join original request/auth/IO work independently of native cleanup. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      for (const cancel of this.cancels) {
        try {
          cancel();
        } catch (value) {
          this.first ??= { value };
        }
      }
      await Promise.allSettled([...this.work]);
      if (this.first) throw this.first.value;
    });
    return this.closing;
  }
}
