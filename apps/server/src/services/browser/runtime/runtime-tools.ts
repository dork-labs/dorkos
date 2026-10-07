import { projectBrowserActionReceipt } from '../api/action-receipt.js';
import type { BrowserRuntimeOwnerResolution } from './runtime-owner-resolution.js';
import type { BrowserControllerNavigation } from '../api/controller-navigation.js';
import type { BrowserSemanticReadHost } from '../api/semantic-read-host.js';
import type { BrowserControllerUpload } from '../api/controller-upload.js';
import type { BrowserControllerDownload } from '../api/controller-download.js';
import {
  SemanticSnapshotV1Schema,
  SemanticReceiptV1Schema,
  SemanticActionV1Schema,
  SemanticActionInputV1Schema,
} from '@dorkos/shared/browser-semantic-schemas';
import {
  BrowserUploadRequestSchema,
  BrowserDownloadRequestSchema,
} from '@dorkos/shared/browser-schemas';
/** These bound originals exist only after the genuine optional factory has constructed its hosts. */
export interface RuntimeBrowserActorCapabilities {
  readSemanticForActor: BrowserSemanticReadHost['readForActor'];
  actionSemanticForActor: BrowserSemanticReadHost['actionForActor'];
  streamSemanticForActor: BrowserSemanticReadHost['streamForActor'];
  stageForActor: BrowserControllerUpload['stageForActor'];
  uploadForActor: BrowserControllerUpload['uploadForActor'];
  downloadForActor: BrowserControllerDownload['downloadForActor'];
}
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import { z } from 'zod';
import type { BrowserLifecycleEngine, OwnedInputAuthorization } from '@dorkos/browser/server-owner';
import {
  BrowserBindingSchema,
  BrowserControlSchema,
  BrowserInputRequestSchema,
  BrowserNavigateRequestSchema,
  BrowserReferenceSchema,
  BrowserCounterSchema,
  type BrowserBinding,
} from '@dorkos/shared/browser-schemas';
import type { CapabilityHandlerContext } from '../../core/capabilities/registry.js';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
} from '../../connectors/principal/server-principal.js';
import type { ConnectorRuntimePrincipalService as RuntimePrincipalService } from '../../connectors/principal/runtime-principal-service.js';
import type { OwnedBrowserGrants } from '../api/grants.js';
import type { OwnedBrowserController, BrowserControllerActor } from '../api/controller.js';
import type { BrowserControllerInput } from '../api/controller-input.js';
import { BrowserApiRefusal } from '../api/service.js';

/** Existing grant references select original authority; no tool argument declares its caller. */
export const ManagedBrowserGrantSchema = z
  .object({
    grantId: BrowserReferenceSchema,
    revision: BrowserCounterSchema,
  })
  .strict();
export const ManagedBrowserTabsSchema = z
  .object({
    binding: BrowserBindingSchema,
    grant: ManagedBrowserGrantSchema,
  })
  .strict();
export const ManagedBrowserControlSchema = ManagedBrowserTabsSchema;
export const ManagedBrowserInputSchema = z
  .object({
    command: BrowserInputRequestSchema,
    controllerId: BrowserReferenceSchema,
    grant: ManagedBrowserGrantSchema,
  })
  .strict();

export const ManagedBrowserNavigateSchema = z
  .object({
    command: BrowserNavigateRequestSchema,
    controllerId: BrowserReferenceSchema,
    grant: ManagedBrowserGrantSchema,
  })
  .strict();

// Callers provide canonical action fields; only the retained original stream supplies its private ID.
export const ManagedBrowserSemanticActionSchema = ManagedBrowserTabsSchema.extend({
  controllerId: BrowserReferenceSchema,
  request: SemanticActionInputV1Schema,
}).strict();
export const ManagedBrowserStageSchema = z
  .object({
    binding: BrowserBindingSchema,
    artifactGrant: ManagedBrowserGrantSchema,
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(255),
    bytesBase64: z.string().min(4).max(2796204),
  })
  .strict();
export const ManagedBrowserUploadSchema = z
  .object({
    command: BrowserUploadRequestSchema,
    controllerId: BrowserReferenceSchema,
    artifactGrant: ManagedBrowserGrantSchema,
    uploadGrant: ManagedBrowserGrantSchema,
    controlGrant: ManagedBrowserGrantSchema,
  })
  .strict();
export const ManagedBrowserDownloadSchema = z
  .object({
    command: BrowserDownloadRequestSchema,
    controllerId: BrowserReferenceSchema,
    artifactGrant: ManagedBrowserGrantSchema,
    downloadGrant: ManagedBrowserGrantSchema,
    controlGrant: ManagedBrowserGrantSchema,
  })
  .strict();

/** Private issuer consumes the real current runtime turn and the original grant/controller banks.
 * Independent acquisition remains in the private birth issuer; arguments never mint authority.
 */
export function createManagedBrowserRuntimeTools(options: {
  principals: Pick<RuntimePrincipalService, 'revalidatePrincipal' | 'isPrincipalCurrent'>;
  authors: Pick<AuthorRegistry, 'resolveAgent'>;
  grants: Pick<OwnedBrowserGrants, 'admit' | 'controllerGrant'>;
  controller: Pick<OwnedBrowserController, 'takeover' | 'authorization'>;
  input: Pick<BrowserControllerInput, 'captureAuthorization'>;
  engine: Pick<BrowserLifecycleEngine, 'listTabs'>;
  owners?: BrowserRuntimeOwnerResolution;
  enabled(): boolean;
  actorCapabilities?: RuntimeBrowserActorCapabilities;
  navigation?: Pick<BrowserControllerNavigation, 'navigateForActor'>;
}) {
  const navigateOriginal = options.navigation?.navigateForActor.bind(options.navigation);
  const optional = options.actorCapabilities;
  const optionalOriginals = optional
    ? Object.freeze({
        read: optional.readSemanticForActor.bind(optional),
        action: optional.actionSemanticForActor.bind(optional),
        stream: optional.streamSemanticForActor.bind(optional),
        stage: optional.stageForActor.bind(optional),
        upload: optional.uploadForActor.bind(optional),
        download: optional.downloadForActor.bind(optional),
      })
    : undefined;
  const resolveAgent = options.authors.resolveAgent.bind(options.authors);
  const revalidate = options.principals.revalidatePrincipal.bind(options.principals);
  const principalCurrent = options.principals.isPrincipalCurrent.bind(options.principals);
  const admit = options.grants.admit.bind(options.grants);
  const controllerGrant = options.grants.controllerGrant.bind(options.grants);
  const takeover = options.controller.takeover.bind(options.controller);
  const authorization = options.controller.authorization.bind(options.controller);
  const input = options.input.captureAuthorization.bind(options.input);
  const tabs = options.engine.listTabs.bind(options.engine);
  const enabled = options.enabled.bind(options);
  const controllers = new Map<string, { identity: object; principal: ServerPrincipalProof }>();
  const pending = new Set<Promise<unknown>>();
  const semanticStreams = new Map<
    string,
    Readonly<{
      leaseId: string;
      stream: Awaited<ReturnType<BrowserSemanticReadHost['streamForActor']>>;
      close(): Promise<void>;
    }>
  >();
  const semanticAdmissions = new Set<string>();
  let failure: Readonly<{ reason: unknown }> | undefined;
  let closed = false,
    closing: Promise<void> | undefined;
  const current = () => {
    if (closed || failure) return false;
    const available = enabled();
    return available && !closed && !failure;
  };
  const capture = async (context: CapabilityHandlerContext, refuse: () => BrowserApiRefusal) => {
    const principal = context.serverPrincipal;
    const signal = context.signal;
    const scopeLive = () => {
      const aborted = signal?.aborted;
      return !aborted && !closed && !failure;
    };
    if (
      !isServerPrincipal(principal) ||
      principal.claims.kind !== 'runtime' ||
      !context.identity ||
      context.identity.inactive ||
      context.trusted ||
      (!options.owners && principal.claims.owner.kind !== 'user') ||
      context.identity.agentPath !== principal.claims.agentPath ||
      context.sessionId !== principal.claims.canonicalSessionId ||
      !current() ||
      signal?.aborted ||
      closed ||
      failure
    )
      throw refuse();
    if (signal?.aborted || closed || failure) throw refuse();
    const claims = principal.claims;
    const mappedOwner = options.owners?.resolve(
      principal,
      () => current() && scopeLive() && principalCurrent(principal) && scopeLive()
    );
    if ((options.owners && !mappedOwner) || !scopeLive()) throw refuse();
    const ownerCurrent = () => !mappedOwner || mappedOwner.current();
    if (
      !(await revalidate(principal)) ||
      !current() ||
      signal?.aborted ||
      !principalCurrent(principal) ||
      closed ||
      failure ||
      !ownerCurrent()
    )
      throw refuse();
    for (const [key, original] of controllers) {
      const live = principalCurrent(original.principal);
      if (signal?.aborted || closed || failure) throw refuse();
      if (!live && controllers.get(key) === original) controllers.delete(key);
    }
    if (!current() || signal?.aborted || closed || failure) throw refuse();
    let owner = controllers.get(claims.bindingId);
    if (!owner) {
      if (controllers.size >= 64) throw refuse();
      owner = { identity: Object.freeze({}), principal };
      controllers.set(claims.bindingId, owner);
    }
    const author = resolveAgent(claims.agentPath, context.identity.displayName);
    if (!scopeLive()) throw refuse();
    const authorCurrent = () => {
      const live = resolveAgent(claims.agentPath, context.identity!.displayName);
      return (
        live.id === author.id &&
        live.kind === 'agent' &&
        live.naturalKey === claims.agentPath &&
        live.mintedForManifestId === claims.agentId
      );
    };
    if (!scopeLive() || !authorCurrent() || !scopeLive()) throw refuse();
    if (!principalCurrent(principal) || !scopeLive()) throw refuse();
    const identity = owner.identity;
    const credential = Object.freeze({
      current: () => {
        if (!scopeLive() || !ownerCurrent()) return false;
        if (!principalCurrent(principal) || !scopeLive()) return false;
        return authorCurrent() && ownerCurrent() && scopeLive();
      },
    });
    const actor: BrowserControllerActor = Object.freeze({
      owner: author.id,
      credential,
      controllerIdentity: identity,
    });
    const read = () => {
      if (!current() || !scopeLive() || !ownerCurrent()) return undefined;
      if (!principalCurrent(principal) || !scopeLive()) return undefined;
      return authorCurrent() && ownerCurrent() && scopeLive() ? actor : undefined;
    };
    const refresh = async () => {
      if (!read()) throw refuse();
      if (!(await revalidate(principal)) || !read()) throw refuse();
    };
    const refreshActor = async () => {
      // A genuine false revokes the private runtime binding; the host's current check issues its own denial.
      // Returning the originally captured actor is not admission and never revives a revoked credential.
      if (read()) await revalidate(principal);
      return actor;
    };
    return { read, refresh, refreshActor, principal };
  };
  const retain = <T>(
    operation: (
      refuse: () => BrowserApiRefusal,
      denial: (reason: unknown) => void,
      parse: <S extends z.ZodType>(schema: S, value: unknown) => z.output<S>,
      isKnown: (reason: unknown) => boolean
    ) => Promise<T>
  ): Promise<T> => {
    const expected = new WeakSet<object>();
    const denial = (reason: unknown) => {
      // This callback is the captured original host's invocation-local receipt, not a class predicate.
      if (typeof reason !== 'object' || reason === null) throw reason;
      expected.add(reason);
    };
    const parse = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => {
      const result = schema.safeParse(value);
      if (!result.success) {
        expected.add(result.error);
        throw result.error;
      }
      return result.data;
    };
    const refuse = () => {
      const reason = new BrowserApiRefusal('inaccessible');
      denial(reason);
      return reason;
    };
    if (failure) return Promise.reject(failure.reason);
    if (closed || pending.size >= 64) return Promise.reject(refuse());
    const original = Promise.resolve().then(() => {
      if (failure) throw failure.reason;
      if (!current()) throw refuse();
      return operation(
        refuse,
        denial,
        parse,
        (reason) => typeof reason === 'object' && reason !== null && expected.has(reason)
      );
    });
    pending.add(original);
    void original.then(
      () => pending.delete(original),
      (reason) => {
        if (!(typeof reason === 'object' && reason !== null && expected.has(reason)))
          failure ??= { reason };
        pending.delete(original);
      }
    );
    return original;
  };
  const actorReceiver = (
    call: Awaited<ReturnType<typeof capture>>,
    denial: (reason: unknown) => void,
    refuse: () => BrowserApiRefusal
  ) =>
    Object.freeze({
      refresh: call.refreshActor,
      current: call.read,
      onOriginalDenial: denial,
      authorization: async (
        binding: BrowserBinding,
        controllerId: string,
        reference?: Readonly<{ grantId: string; revision: number }>,
        observed?: (reason: BrowserApiRefusal) => void
      ): Promise<OwnedInputAuthorization> => {
        const report = (reason: BrowserApiRefusal) => {
          denial(reason);
          observed?.(reason);
        };
        if (!reference) throw refuse();
        await call.refreshActor();
        const grant = controllerGrant(
          call.read,
          reference.grantId,
          reference.revision,
          binding,
          report
        );
        return authorization(call.read, binding, controllerId, grant, {
          propagateFailures: true,
          onOriginalDenial: report,
        });
      },
    });
  return Object.freeze({
    available: current,
    tabs(context: CapabilityHandlerContext, value: unknown) {
      return retain(async (refuse, denial, parse) => {
        const request = parse(ManagedBrowserTabsSchema, value),
          call = await capture(context, refuse);
        admit(
          call.read,
          request.grant.grantId,
          request.grant.revision,
          request.binding,
          'browser.view',
          denial
        );
        const actual = tabs(request.binding.browserId, request.binding.browserGeneration);
        const selected = actual.filter((row) => row.tabId === request.binding.tabId);
        if (selected.length !== 1) throw refuse();
        const binding = BrowserBindingSchema.parse(selected[0]);
        await call.refresh();
        admit(
          call.read,
          request.grant.grantId,
          request.grant.revision,
          binding,
          'browser.view',
          denial
        );
        if (!call.read()) throw refuse();
        return [binding];
      });
    },
    control(context: CapabilityHandlerContext, value: unknown) {
      return retain(async (refuse, denial, parse) => {
        const request = parse(ManagedBrowserControlSchema, value),
          call = await capture(context, refuse);
        const grant = controllerGrant(
          call.read,
          request.grant.grantId,
          request.grant.revision,
          request.binding,
          denial
        );
        const result = BrowserControlSchema.parse(
          await takeover(call.read, request.binding, grant)
        );
        await call.refresh();
        admit(
          call.read,
          request.grant.grantId,
          request.grant.revision,
          result.binding,
          'browser.control',
          denial
        );
        if (!call.read()) throw refuse();
        return result;
      });
    },
    input(context: CapabilityHandlerContext, value: unknown) {
      return retain(async (refuse, denial, parse) => {
        const request = parse(ManagedBrowserInputSchema, value),
          call = await capture(context, refuse);
        const client = input(async (binding, controllerId, reference) => {
          if (!reference) throw refuse();
          await call.refresh();
          const grant = controllerGrant(
            call.read,
            reference.grantId,
            reference.revision,
            binding,
            denial
          );
          const original = authorization(call.read, binding, controllerId, grant, {
            propagateFailures: true,
            onOriginalDenial: denial,
          });
          const originalCurrent = original.isCurrent.bind(original);
          const originalAuthorize = original.authorize.bind(original);
          const proof: OwnedInputAuthorization = Object.freeze({
            isCurrent: () => !!call.read() && originalCurrent() && !!call.read(),
            authorize: async (...args: Parameters<OwnedInputAuthorization['authorize']>) => {
              await call.refresh();
              const verdict = await originalAuthorize(...args);
              return call.read() ? verdict : 'refused';
            },
          });
          return proof;
        });
        // Original engine receipts preserve uncertain side effects; no retry or synthetic success.
        const receipt = projectBrowserActionReceipt(
          await client.input(request.command, request.controllerId, request.grant, context.signal)
        );
        await call.refresh();
        admit(
          call.read,
          request.grant.grantId,
          request.grant.revision,
          receipt.binding,
          'browser.control',
          denial
        );
        if (!call.read()) throw refuse();
        return receipt;
      });
    },
    navigate(context: CapabilityHandlerContext, value: unknown) {
      return retain(async (refuse, denial, parse) => {
        if (!navigateOriginal) throw refuse();
        const request = parse(ManagedBrowserNavigateSchema, value),
          call = await capture(context, refuse);
        const grant = controllerGrant(
          call.read,
          request.grant.grantId,
          request.grant.revision,
          request.command.binding,
          denial
        );
        return navigateOriginal(
          Object.freeze({
            refresh: call.refreshActor,
            current: call.read,
            onOriginalDenial: denial,
          }),
          request.command,
          request.controllerId,
          grant,
          context.signal
        );
      });
    },
    optionalAvailable: () => !!optionalOriginals && current(),
    semanticRead(context: CapabilityHandlerContext, value: unknown) {
      return retain(async (refuse, denial, parse, isKnown) => {
        if (!optionalOriginals) throw refuse();
        const request = parse(ManagedBrowserTabsSchema, value),
          call = await capture(context, refuse);
        const key = JSON.stringify([
          call.principal.claims.kind === 'runtime' ? call.principal.claims.bindingId : '',
          request.binding.browserId,
          request.binding.browserGeneration,
          request.binding.tabId,
        ]);
        if (!current() || !call.read() || semanticAdmissions.has(key)) throw refuse();
        const occupied = new Set([...semanticStreams.keys(), ...semanticAdmissions]);
        if (!occupied.has(key) && occupied.size >= 8) throw refuse();
        semanticAdmissions.add(key);
        try {
          const old = semanticStreams.get(key);
          if (old) {
            await old.close();
            if (semanticStreams.get(key) === old) semanticStreams.delete(key);
          }
          if (!call.read() || !current()) throw refuse();
          const receiver = Object.freeze({
            refresh: call.refreshActor,
            current: call.read,
            onOriginalDenial: denial,
          });
          const snapshot = SemanticSnapshotV1Schema.parse(
            await optionalOriginals.read(
              receiver,
              request,
              context.signal ?? new AbortController().signal
            )
          );
          if (
            Object.entries(request.binding).some(
              ([key, value]) => snapshot[key as keyof typeof snapshot] !== value
            ) ||
            snapshot.grantRevision !== request.grant.revision
          )
            throw new Error('MANAGED_SEMANTIC_BINDING_MISMATCH');
          if (!call.read() || !current()) throw refuse();
          const stream = await optionalOriginals.stream(
            receiver,
            { ...request, leaseId: snapshot.semanticLeaseId },
            context.signal ?? new AbortController().signal
          );
          let closing: Promise<void> | undefined;
          const close = () => (closing ??= Promise.resolve().then(() => stream.close()));
          const cell = Object.freeze({
            leaseId: snapshot.semanticLeaseId,
            stream,
            close,
          });
          // Retain the actual birth before any subsequent authority callback can fail.
          semanticStreams.set(key, cell);
          try {
            if (!call.read() || !current()) throw refuse();
            return snapshot;
          } catch (primary) {
            if (!isKnown(primary)) failure ??= { reason: primary };
            try {
              await close();
              if (semanticStreams.get(key) === cell) semanticStreams.delete(key);
            } catch (cleanup) {
              failure ??= { reason: cleanup };
            }
            throw primary;
          }
        } finally {
          semanticAdmissions.delete(key);
        }
      });
    },
    semanticAction(context: CapabilityHandlerContext, value: unknown) {
      return retain(async (refuse, denial, parse) => {
        if (!optionalOriginals) throw refuse();
        const request = parse(ManagedBrowserSemanticActionSchema, value),
          call = await capture(context, refuse);
        const key = JSON.stringify([
          call.principal.claims.kind === 'runtime' ? call.principal.claims.bindingId : '',
          request.binding.browserId,
          request.binding.browserGeneration,
          request.binding.tabId,
        ]);
        const cell = semanticStreams.get(key);
        if (!cell || cell.leaseId !== request.request.identity.semanticLeaseId) throw refuse();
        const tracked = ['insertText', 'replaceText', 'writeSecret', 'key'].includes(
          request.request.action.kind
        );
        const actual = {
          ...request,
          request: SemanticActionV1Schema.parse({
            ...request.request,
            ...(tracked ? { eventStreamId: cell.stream.eventStreamId } : {}),
          }),
        };
        const receiver = Object.freeze({
          refresh: call.refreshActor,
          current: call.read,
          onOriginalDenial: denial,
        });
        // No stream handle is exported. Native object/lease/controller authority remains in the original host.
        const receipt = SemanticReceiptV1Schema.parse(
          await optionalOriginals.action(
            receiver,
            actual,
            context.signal ?? new AbortController().signal
          )
        );
        if (
          receipt.requestId !== actual.request.requestId ||
          Object.entries(receipt.identity).some(
            ([key, value]) =>
              actual.request.identity[key as keyof typeof actual.request.identity] !== value
          )
        )
          throw new Error('MANAGED_SEMANTIC_RECEIPT_MISMATCH');
        return receipt;
      });
    },
    stageUpload(context: CapabilityHandlerContext, value: unknown) {
      return retain(async (refuse, denial, parse) => {
        if (!optionalOriginals) throw refuse();
        const request = parse(ManagedBrowserStageSchema, value),
          call = await capture(context, refuse);
        const bytes = Buffer.from(request.bytesBase64, 'base64');
        try {
          if (
            !bytes.length ||
            bytes.length > 2 * 1024 * 1024 ||
            bytes.toString('base64') !== request.bytesBase64
          )
            throw refuse();
          return await optionalOriginals.stage(
            actorReceiver(call, denial, refuse),
            request.binding,
            request.artifactGrant,
            request.name,
            request.mimeType,
            bytes,
            context.signal ?? new AbortController().signal
          );
        } finally {
          bytes.fill(0);
        }
      });
    },
    upload(context: CapabilityHandlerContext, value: unknown) {
      return retain(async (refuse, denial, parse) => {
        if (!optionalOriginals) throw refuse();
        const request = parse(ManagedBrowserUploadSchema, value),
          call = await capture(context, refuse);
        const receipt = await optionalOriginals.upload(
          actorReceiver(call, denial, refuse),
          request.command,
          request.controllerId,
          request.artifactGrant,
          request.uploadGrant,
          request.controlGrant,
          context.signal
        );
        return projectBrowserActionReceipt(receipt);
      });
    },
    download(context: CapabilityHandlerContext, value: unknown) {
      return retain(async (refuse, denial, parse) => {
        if (!optionalOriginals) throw refuse();
        const request = parse(ManagedBrowserDownloadSchema, value),
          call = await capture(context, refuse);
        const result = await optionalOriginals.download(
          actorReceiver(call, denial, refuse),
          request.command,
          request.controllerId,
          request.artifactGrant,
          request.downloadGrant,
          request.controlGrant,
          context.signal
        );
        return Object.freeze({
          ...result,
          input: projectBrowserActionReceipt(result.input),
        });
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      let yes!: () => void, no!: (reason: unknown) => void;
      closing = new Promise<void>((resolve, reject) => {
        yes = resolve;
        no = reject;
      });
      closed = true;
      const streamCloses = [...semanticStreams.values()].map((cell) => cell.close());
      void Promise.allSettled([Promise.allSettled([...pending]), ...streamCloses]).then(
        (results) => {
          for (const result of results)
            if (result.status === 'rejected') failure ??= { reason: result.reason };
          semanticStreams.clear();
          controllers.clear();
          if (failure) no(failure.reason);
          else yes();
        }
      );
      return closing;
    },
  });
}
