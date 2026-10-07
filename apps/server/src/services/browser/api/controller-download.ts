import type { Request, Response } from 'express';
import type {
  PrivateBrowserDownloadOwner,
  PrivateBrowserDownloadDispatcher,
  OwnedInputAuthorization,
  OwnedDownloadSink,
  OwnedDownloadArtifact,
} from '@dorkos/browser/server-owner';
import {
  BrowserActionReceiptSchema,
  BrowserDownloadRequestSchema,
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
/** Authenticated response transfer; native response IDs and filesystem paths stay server-private. */
export class BrowserControllerDownload {
  readonly owner: PrivateBrowserDownloadOwner;
  private dispatch?: PrivateBrowserDownloadDispatcher['download'];
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
      registerDispatcher: (original: PrivateBrowserDownloadDispatcher) => {
        if (this.closed || this.dispatch) throw browserFileRefusal('unavailable');
        const download = original.download.bind(original);
        if (this.closed || this.dispatch) throw browserFileRefusal('unavailable');
        this.dispatch = download;
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
    deniedBeforeDispatch: (value: unknown) => boolean
  ): Promise<T> {
    this.work.add(original);
    void original.then(
      () => this.work.delete(original),
      (value) => {
        if (!deniedBeforeDispatch(value)) this.first ??= Object.freeze({ value });
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
  /** Actual controller, artifact access and browser.download each remain separate current permissions. */
  download(
    req: Request,
    res: Response,
    value: unknown,
    controllerId: string,
    artifact: Reference,
    download: Reference,
    control?: Reference,
    signal?: AbortSignal,
    localTicket?: string
  ) {
    return this.downloadOriginal(
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
      download,
      control,
      signal
    );
  }
  /** Select an exact response through original runtime actor and independent download/artifact/controller grants. */
  downloadForActor(
    original: BrowserArtifactActorAdmission,
    value: unknown,
    controllerId: string,
    artifact: Reference,
    download: Reference,
    control?: Reference,
    signal?: AbortSignal
  ) {
    return this.downloadOriginal(
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
      download,
      control,
      signal
    );
  }
  private downloadOriginal(
    acquire: () => {
      auth: Pick<BrowserArtifactActorAdmission, 'refresh' | 'current' | 'onOriginalDenial'>;
      authorize: BrowserArtifactActorAdmission['authorization'];
      guard(local?: () => BrowserApiRefusal): void;
    },
    value: unknown,
    controllerId: string,
    artifact: Reference,
    download: Reference,
    control?: Reference,
    signal?: AbortSignal
  ) {
    if (this.closed || !this.dispatch || !this.captureController || this.work.size >= 16)
      throw browserFileRefusal('unavailable');
    artifact = reference(artifact);
    download = reference(download);
    control = control ? reference(control) : undefined;
    controllerId = BrowserReferenceSchema.parse(controllerId);
    const parsed = BrowserDownloadRequestSchema.parse(value);
    const command = Object.freeze({
      ...parsed,
      binding: Object.freeze({ ...parsed.binding }),
      activation: Object.freeze({ ...parsed.activation }),
    });
    const dispatch = this.dispatch;
    const phase: {
      entered: boolean;
      denial?: Readonly<{ value: unknown }>;
      report?: (value: BrowserApiRefusal) => void;
    } = { entered: false };
    const originalDenial = (value: BrowserApiRefusal) => {
      phase.denial = Object.freeze({ value });
      try {
        phase.report?.(value);
      } catch (fault) {
        this.first ??= { value: fault };
      }
    };
    const local = () => {
      const value = browserFileRefusal('inaccessible');
      if (!phase.entered) originalDenial(value);
      return value;
    };
    return this.retain(
      Promise.resolve().then(async () => {
        if (!this.active()) throw local();
        const { auth, authorize, guard } = acquire();
        if (!this.active()) throw local();
        phase.report = auth.onOriginalDenial;
        const actor = await auth.refresh();
        // Genuine permission/current-binding denial before any controller/native/file effect is a refused request,
        // not lost custody. Unknown callback failures remain unmarked and sticky.
        this.admit(
          auth.current,
          artifact.grantId,
          artifact.revision,
          command.binding,
          'browser.artifact',
          originalDenial
        );
        this.admit(
          auth.current,
          download.grantId,
          download.revision,
          command.binding,
          'browser.download',
          originalDenial
        );
        const authority = await authorize(command.binding, controllerId, control, originalDenial);
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
            !phase.entered ? originalDenial : undefined
          );
          this.admit(
            auth.current,
            download.grantId,
            download.revision,
            command.binding,
            'browser.download',
            !phase.entered ? originalDenial : undefined
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
            if (!phase.entered) originalDenial(refusal);
            throw refusal;
          }
          return true;
        };
        current();
        let discard: (() => Promise<void>) | undefined;
        let staging = false;
        let stagedMetadata: OwnedDownloadArtifact | undefined;
        const sink: OwnedDownloadSink = Object.freeze<OwnedDownloadSink>({
          binding: command.binding,
          authorize: async (_binding, originalSignal) => {
            originalSignal.throwIfAborted();
            await auth.refresh();
            current();
          },
          stage: async (name, mimeType, bytes, originalSignal) => {
            if (staging) throw browserFileRefusal('unavailable');
            staging = true;
            originalSignal.throwIfAborted();
            await auth.refresh();
            current();
            const staged = await this.artifacts.stage(
              actor,
              command.binding,
              name,
              mimeType,
              bytes,
              current
            );
            // Exact cell cleanup is adopted before any further fallible admission or metadata projection.
            discard = staged.discard.bind(staged);
            originalSignal.throwIfAborted();
            current();
            stagedMetadata = Object.freeze({
              artifactId: staged.artifactId,
              byteLength: staged.byteLength,
              name,
              mimeType,
            });
            return stagedMetadata;
          },
        });
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
          phase.entered = true; // Set before the original receiver can synchronously enter or refuse an effect.
          const delivered = await dispatch(command, original, sink, signal);
          if (!delivered || !stagedMetadata || delivered.artifact !== stagedMetadata)
            throw browserFileRefusal('unavailable');
          const { kind, ...fields } = delivered.input;
          const checked = BrowserActionReceiptSchema.parse(fields);
          if (
            kind !== 'action' ||
            checked.outcome !== 'completed' ||
            checked.requestId !== command.requestId ||
            JSON.stringify(checked.binding) !== JSON.stringify(command.binding)
          )
            throw browserFileRefusal('unavailable');
          const result = Object.freeze({
            input: Object.freeze({
              kind,
              ...checked,
              binding: Object.freeze(checked.binding),
            }),
            artifact: stagedMetadata,
          });
          await auth.refresh();
          current();
          return result;
        } catch (value) {
          this.first ??= Object.freeze({ value });
          try {
            if (discard) await discard();
          } catch (cleanup) {
            this.first ??= Object.freeze({ value: cleanup });
          }
          throw value;
        }
      }),
      (value) => !phase.entered && phase.denial !== undefined && phase.denial.value === value
    );
  }
  /** Fence new response transfers and join actual IO and staged-cell ownership before cleanup. */
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
