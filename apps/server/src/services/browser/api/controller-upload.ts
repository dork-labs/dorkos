import type { Request, Response } from 'express';
import type {
  PrivateBrowserUploadOwner,
  PrivateBrowserUploadDispatcher,
  OwnedInputAuthorization,
  OwnedUploadLease,
} from '@dorkos/browser/server-owner';
import {
  BrowserBindingSchema,
  BrowserUploadRequestSchema,
  BrowserReferenceSchema,
  BrowserCounterSchema,
} from '@dorkos/shared/browser-schemas';
import { resolveBrowserOriginFacts } from '../../../middleware/browser-origin.js';
import { isTrustedBrowserOrigin } from '../../../lib/trusted-origins.js';
import type { BrowserControllerHost } from './controller-host.js';
import type { BrowserControllerIdentities } from './controller-auth.js';
import type { OwnedBrowserGrants } from './grants.js';
import { BrowserUploadArtifacts } from './files/upload-artifacts.js';
import { captureArtifactActor, type BrowserArtifactActorAdmission } from './artifact-actor.js';
import type { BrowserApiRefusal } from './service.js';
import { browserFileRefusal } from './files/file-refusal.js';

type Reference = Readonly<{ grantId: string; revision: number }>;
const reference = (value: Reference): Reference =>
  Object.freeze({
    grantId: BrowserReferenceSchema.parse(value.grantId),
    revision: BrowserCounterSchema.parse(value.revision),
  });
/** Authenticated file staging and once-only chooser dispatch; filesystem paths stay server-private. */
export class BrowserControllerUpload {
  readonly owner: PrivateBrowserUploadOwner;
  private dispatch?: PrivateBrowserUploadDispatcher['upload'];
  private captureController?: BrowserControllerHost['capture'];
  private readonly captureIdentity: BrowserControllerIdentities['capture'];
  private readonly admit: OwnedBrowserGrants['admit'];
  private readonly work = new Set<Promise<unknown>>();
  private first?: Readonly<{ value: unknown }>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    private readonly artifacts: BrowserUploadArtifacts,
    identities: BrowserControllerIdentities,
    grants: OwnedBrowserGrants,
    private readonly enabled: () => boolean
  ) {
    this.captureIdentity = identities.capture.bind(identities);
    this.admit = grants.admit.bind(grants);
    this.owner = Object.freeze({
      registerDispatcher: (original: PrivateBrowserUploadDispatcher) => {
        if (this.closed || this.dispatch) throw browserFileRefusal('unavailable');
        const upload = original.upload.bind(original);
        if (this.closed || this.dispatch) throw browserFileRefusal('unavailable');
        this.dispatch = upload;
      },
    });
  }
  /** Capture the genuine controller host once after the original engine constructor has registered its dispatcher. */
  bindHost(control: BrowserControllerHost): void {
    if (this.closed || this.captureController || this.work.size)
      throw browserFileRefusal('unavailable');
    const capture = control.capture.bind(control);
    if (this.closed || this.captureController || this.work.size)
      throw browserFileRefusal('unavailable');
    this.captureController = capture;
  }
  private retain<T>(
    original: Promise<T>,
    denied: (value: unknown) => boolean = () => false
  ): Promise<T> {
    this.work.add(original);
    void original.then(
      () => this.work.delete(original),
      (value) => {
        if (!denied(value)) this.first ??= Object.freeze({ value });
        this.work.delete(original);
      }
    );
    return original;
  }
  private active(): boolean {
    if (this.closed || this.first) return false;
    const enabled = this.enabled();
    return enabled && !this.closed && !this.first;
  }
  private origin(req: Request): string {
    const facts = resolveBrowserOriginFacts(req, { hostCheckInert: false });
    if (
      this.closed ||
      !this.enabled() ||
      req.method !== 'POST' ||
      !facts.origin ||
      !facts.hostAllowed ||
      !isTrustedBrowserOrigin(facts, {
        allowNoOrigin: false,
        pairSameOriginWithHost: true,
      })
    )
      throw browserFileRefusal('inaccessible');
    return facts.origin;
  }
  /** Capture actual server-store identity and independent artifact grant before receiving bounded bytes. */
  stage(
    req: Request,
    res: Response,
    bindingValue: unknown,
    artifact: Reference,
    name: string,
    mimeType: string,
    bytes: Uint8Array,
    signal: AbortSignal,
    localTicket?: string
  ) {
    return this.stageOriginal(
      () => {
        const origin = this.origin(req);
        const auth = this.captureIdentity(req, res, localTicket);
        return {
          auth,
          guard: () => {
            if (this.origin(req) !== origin) throw browserFileRefusal('inaccessible');
          },
        };
      },
      bindingValue,
      artifact,
      name,
      mimeType,
      bytes,
      signal
    );
  }
  /** Receive bounded bytes only through an original current runtime actor and explicit artifact grant. */
  stageForActor(
    original: BrowserArtifactActorAdmission,
    bindingValue: unknown,
    artifact: Reference,
    name: string,
    mimeType: string,
    bytes: Uint8Array,
    signal: AbortSignal
  ) {
    return this.stageOriginal(
      () => ({
        auth: captureArtifactActor(original),
        guard: (local?: () => BrowserApiRefusal) => {
          if (!this.active()) throw local?.() ?? browserFileRefusal('inaccessible');
        },
      }),
      bindingValue,
      artifact,
      name,
      mimeType,
      bytes,
      signal
    );
  }
  private stageOriginal(
    acquire: () => {
      auth: Pick<BrowserArtifactActorAdmission, 'refresh' | 'current' | 'onOriginalDenial'>;
      guard(local?: () => BrowserApiRefusal): void;
    },
    bindingValue: unknown,
    artifact: Reference,
    name: string,
    mimeType: string,
    bytes: Uint8Array,
    signal: AbortSignal
  ) {
    if (this.closed || this.work.size >= 16) throw browserFileRefusal('unavailable');
    artifact = reference(artifact);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > 2 * 1024 * 1024
    )
      throw browserFileRefusal('inaccessible');
    const binding = Object.freeze(BrowserBindingSchema.parse(bindingValue));
    const originalBytes = Buffer.from(bytes);
    const phase: {
      entered: boolean;
      denial?: unknown;
      reported: boolean;
      report?: (value: BrowserApiRefusal) => void;
    } = {
      entered: false,
      reported: false,
    };
    const local = () => {
      const value = browserFileRefusal('inaccessible');
      if (!phase.entered) {
        phase.denial = value;
        phase.reported = true;
        try {
          phase.report?.(value);
        } catch (fault) {
          this.first ??= { value: fault };
        }
      }
      return value;
    };
    return this.retain(
      Promise.resolve()
        .then(async () => {
          if (!this.active()) throw local();
          const { auth, guard } = acquire();
          if (!this.active()) throw local();
          phase.report = auth.onOriginalDenial;
          const actor = await auth.refresh();
          const denial = auth.onOriginalDenial
            ? (value: BrowserApiRefusal) => {
                phase.denial = value;
                phase.reported = true;
                try {
                  auth.onOriginalDenial!(value);
                } catch (fault) {
                  this.first ??= { value: fault };
                }
              }
            : undefined;
          const current = () => {
            signal.throwIfAborted();
            guard(!phase.entered ? local : undefined);
            this.admit(
              auth.current,
              artifact.grantId,
              artifact.revision,
              binding,
              'browser.artifact',
              !phase.entered ? denial : undefined
            );
            const final = auth.current();
            if (
              !final ||
              final.credential !== actor.credential ||
              final.owner !== actor.owner ||
              this.closed
            ) {
              const refusal = browserFileRefusal('inaccessible');
              if (!phase.entered) denial?.(refusal);
              throw refusal;
            }
            return true;
          };
          current();
          phase.entered = true;
          const result = await this.artifacts.stage(
            actor,
            binding,
            name,
            mimeType,
            originalBytes,
            current
          );
          const discard = result.discard.bind(result);
          try {
            await auth.refresh();
            current();
            return Object.freeze({
              artifactId: result.artifactId,
              byteLength: result.byteLength,
            });
          } catch (value) {
            // Retain the original publication failure before independent exact unpublished-cell cleanup.
            this.first ??= Object.freeze({ value });
            try {
              await discard();
            } catch (cleanup) {
              this.first ??= Object.freeze({ value: cleanup });
            }
            throw value;
          }
        })
        .finally(() => originalBytes.fill(0)),
      (value) => !phase.entered && phase.reported && Object.is(value, phase.denial)
    );
  }
  /** Actual controller, artifact access and browser.upload each remain separate current permissions. */
  upload(
    req: Request,
    res: Response,
    value: unknown,
    controllerId: string,
    artifact: Reference,
    upload: Reference,
    control?: Reference,
    signal?: AbortSignal,
    localTicket?: string
  ): ReturnType<PrivateBrowserUploadDispatcher['upload']> {
    return this.uploadOriginal(
      () => {
        const origin = this.origin(req),
          auth = this.captureIdentity(req, res, localTicket);
        const client = this.captureController!(req, res, localTicket);
        return {
          auth,
          authorize: client.authorization.bind(client),
          guard: () => {
            if (this.origin(req) !== origin) throw browserFileRefusal('inaccessible');
          },
        };
      },
      value,
      controllerId,
      artifact,
      upload,
      control,
      signal
    );
  }
  /** Dispatch once using original actor, strict controller and separately granted artifact/upload permission. */
  uploadForActor(
    original: BrowserArtifactActorAdmission,
    value: unknown,
    controllerId: string,
    artifact: Reference,
    upload: Reference,
    control?: Reference,
    signal?: AbortSignal
  ): ReturnType<PrivateBrowserUploadDispatcher['upload']> {
    return this.uploadOriginal(
      () => {
        const auth = captureArtifactActor(original);
        return {
          auth,
          authorize: auth.authorization,
          guard: (local?: () => BrowserApiRefusal) => {
            if (!this.active()) throw local?.() ?? browserFileRefusal('inaccessible');
          },
        };
      },
      value,
      controllerId,
      artifact,
      upload,
      control,
      signal
    );
  }
  private uploadOriginal(
    acquire: () => {
      auth: Pick<BrowserArtifactActorAdmission, 'refresh' | 'current' | 'onOriginalDenial'>;
      authorize: BrowserArtifactActorAdmission['authorization'];
      guard(local?: () => BrowserApiRefusal): void;
    },
    value: unknown,
    controllerId: string,
    artifact: Reference,
    upload: Reference,
    control?: Reference,
    signal?: AbortSignal
  ): ReturnType<PrivateBrowserUploadDispatcher['upload']> {
    if (this.closed || !this.dispatch || !this.captureController || this.work.size >= 16)
      throw browserFileRefusal('unavailable');
    artifact = reference(artifact);
    upload = reference(upload);
    control = control ? reference(control) : undefined;
    controllerId = BrowserReferenceSchema.parse(controllerId);
    const parsed = BrowserUploadRequestSchema.parse(value);
    const command = Object.freeze({
      ...parsed,
      binding: Object.freeze({ ...parsed.binding }),
      activation: Object.freeze({ ...parsed.activation }),
    });
    const dispatch = this.dispatch;
    const phase: {
      entered: boolean;
      denial?: unknown;
      reported: boolean;
      report?: (value: BrowserApiRefusal) => void;
    } = {
      entered: false,
      reported: false,
    };
    const local = () => {
      const value = browserFileRefusal('inaccessible');
      if (!phase.entered) {
        phase.denial = value;
        phase.reported = true;
        try {
          phase.report?.(value);
        } catch (fault) {
          this.first ??= { value: fault };
        }
      }
      return value;
    };
    return this.retain(
      Promise.resolve().then(async () => {
        if (!this.active()) throw local();
        const { auth, authorize, guard } = acquire();
        if (!this.active()) throw local();
        phase.report = auth.onOriginalDenial;
        const actor = await auth.refresh();
        const denial = auth.onOriginalDenial
          ? (value: BrowserApiRefusal) => {
              phase.denial = value;
              phase.reported = true;
              try {
                auth.onOriginalDenial!(value);
              } catch (fault) {
                this.first ??= { value: fault };
              }
            }
          : undefined;
        this.admit(
          auth.current,
          artifact.grantId,
          artifact.revision,
          command.binding,
          'browser.artifact',
          denial
        );
        this.admit(
          auth.current,
          upload.grantId,
          upload.revision,
          command.binding,
          'browser.upload',
          denial
        );
        const authority = await authorize(command.binding, controllerId, control, denial);
        const controllerCurrent = authority.isCurrent.bind(authority),
          step = authority.authorize.bind(authority);
        const current = () => {
          signal?.throwIfAborted();
          guard(!phase.entered ? local : undefined);
          this.admit(
            auth.current,
            artifact.grantId,
            artifact.revision,
            command.binding,
            'browser.artifact',
            !phase.entered ? denial : undefined
          );
          this.admit(
            auth.current,
            upload.grantId,
            upload.revision,
            command.binding,
            'browser.upload',
            !phase.entered ? denial : undefined
          );
          const final = auth.current();
          if (
            !final ||
            final.credential !== actor.credential ||
            final.owner !== actor.owner ||
            !controllerCurrent() ||
            this.closed
          ) {
            const refusal = browserFileRefusal('inaccessible');
            if (!phase.entered) denial?.(refusal);
            throw refusal;
          }
          return true;
        };
        current();
        phase.entered = true;
        const staged = this.artifacts.claim(actor, command.binding, command.artifactId, current);
        const consume = staged.consume.bind(staged),
          enter = staged.enter.bind(staged),
          close = staged.close.bind(staged);
        const lease: OwnedUploadLease = Object.freeze({
          artifactId: staged.artifactId,
          binding: staged.binding,
          consume: async (originalSignal: AbortSignal) => {
            await auth.refresh();
            current();
            const payload = await consume(originalSignal);
            current();
            return payload;
          },
          enter: async (effect: () => Promise<void>) => {
            await auth.refresh();
            current();
            await enter(() => {
              current();
              return effect();
            });
            current();
          },
          close,
        });
        let failure: Readonly<{ value: unknown }> | undefined,
          result: Awaited<ReturnType<typeof dispatch>> | undefined;
        try {
          const original: OwnedInputAuthorization = Object.freeze({
            isCurrent: current,
            authorize: async (...args: Parameters<OwnedInputAuthorization['authorize']>) => {
              await auth.refresh();
              current();
              const allowed = await step(...args);
              current();
              return allowed;
            },
          });
          result = await dispatch(command, original, lease, signal);
          await auth.refresh();
          current();
        } catch (value) {
          failure = { value };
        }
        try {
          await lease.close();
        } catch (value) {
          failure ??= { value };
        }
        if (failure) throw failure.value;
        if (!result) throw browserFileRefusal('unavailable');
        return result;
      }),
      (value) => !phase.entered && phase.reported && Object.is(value, phase.denial)
    );
  }
  /** Fence new steps and join all actual chooser/staging operations before owned file cleanup. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.work]);
      try {
        await this.artifacts.close();
      } catch (value) {
        this.first ??= { value };
      }
      if (this.first) throw this.first.value;
    });
    return this.closing;
  }
}
