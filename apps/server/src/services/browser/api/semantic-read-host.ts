import {
  isOriginalSemanticDeliveryAbort,
  inheritSemanticDeliveryAbort,
} from './semantic-delivery-cancel.js';
import {
  SemanticSnapshotV1Schema,
  SemanticReceiptV1Schema,
  SemanticEventV1Schema,
} from '@dorkos/shared/browser-semantic-schemas';
import { SemanticActionV1Schema } from '@dorkos/shared/browser-semantic-schemas';
import type { OwnedBrowserController, BrowserControllerActor } from './controller.js';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  BrowserBindingSchema,
  BrowserReferenceSchema,
  type BrowserBinding,
} from '@dorkos/shared/browser-schemas';
import type {
  PrivateBrowserSemanticOwner,
  PrivateBrowserSemanticDispatcher,
  OwnedSemanticReadAuthorization,
  OwnedSemanticControlAuthorization,
} from '@dorkos/browser/server-owner';
import { resolveBrowserOriginFacts } from '../../../middleware/browser-origin.js';
import { isTrustedBrowserOrigin } from '../../../lib/trusted-origins.js';
import { type BrowserControllerIdentities } from './controller-auth.js';
import { type OwnedBrowserGrants } from './grants.js';
import { BrowserApiRefusal } from './service.js';

/** Original private producer from the retained server session or runtime principal service. */
export interface BrowserSemanticActorAdmission {
  refresh(): Promise<BrowserControllerActor>;
  current(): BrowserControllerActor | undefined;
  /** Private original observer of a newly qualified refusal from this exact host call. */
  onOriginalDenial?(value: unknown): void;
}

const requestSchema = z
  .object({
    binding: BrowserBindingSchema,
    grant: z
      .object({
        grantId: BrowserReferenceSchema,
        revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .optional(),
    confirmSecret: z.literal(true).optional(),
  })
  .strict();
const resolveSchema = requestSchema
  .extend({ leaseId: BrowserReferenceSchema, nodeRef: BrowserReferenceSchema })
  .strict();
const streamSchema = requestSchema.extend({ leaseId: BrowserReferenceSchema }).strict();
const actionSchema = requestSchema
  .extend({
    controllerId: BrowserReferenceSchema,
    request: SemanticActionV1Schema,
  })
  .strict();
type SemanticHostRequest = z.infer<typeof requestSchema> &
  Partial<
    z.infer<typeof resolveSchema> & z.infer<typeof streamSchema> & z.infer<typeof actionSchema>
  >;
function refuse() {
  const error = new BrowserApiRefusal('inaccessible');
  return error;
}

/** Constructor-private, read-only composition; it registers no public route or action capability. */
export class BrowserSemanticReadHost implements PrivateBrowserSemanticOwner {
  private dispatcher?: PrivateBrowserSemanticDispatcher;
  private readonly captureIdentity: BrowserControllerIdentities['capture'];
  private readonly viewerGrant: OwnedBrowserGrants['viewerGrant'];
  private readonly admitViewer: OwnedBrowserGrants['admitViewer'];
  private readonly controlGrant: OwnedBrowserGrants['controllerGrant'];
  private readonly admitPermission: OwnedBrowserGrants['admit'];
  private readonly ownerSemantic: OwnedBrowserGrants['ownerSemantic'];
  private readonly streams = new Map<
    import('@dorkos/browser/server-owner').PrivateSemanticStream,
    Readonly<{ known(value: unknown): boolean; close(): Promise<void> }>
  >();
  private streamBirths = 0;
  private readonly actors = new WeakMap<object, string>();
  private readonly grants = new WeakMap<object, string>();
  private readonly wireStreams = new Map<
    string,
    Readonly<{
      stream: import('@dorkos/browser/server-owner').PrivateSemanticStream;
      actor: string;
      grant: string;
      cancel(): void;
    }>
  >();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;
  private first?: Readonly<{ value: unknown }>;
  private throwOriginalFailure(): void {
    if (this.first) throw this.first.value;
  }

  constructor(
    identities: Pick<BrowserControllerIdentities, 'capture'>,
    private readonly ownedGrants: OwnedBrowserGrants,
    private readonly enabled: () => boolean = () => false,
    private readonly controller?: OwnedBrowserController
  ) {
    this.captureIdentity = identities.capture.bind(identities);
    this.viewerGrant = ownedGrants.viewerGrant.bind(ownedGrants);
    this.admitViewer = ownedGrants.admitViewer.bind(ownedGrants);
    this.controlGrant = ownedGrants.controllerGrant.bind(ownedGrants);
    this.admitPermission = ownedGrants.admit.bind(ownedGrants);
    this.ownerSemantic = ownedGrants.ownerSemantic.bind(ownedGrants);
  }
  /** Exactly one original engine dispatcher is retained before any request can enter. */
  registerDispatcher(dispatcher: PrivateBrowserSemanticDispatcher): void {
    if (this.closed || this.dispatcher) throw refuse();
    const read = dispatcher.read.bind(dispatcher),
      resolve = dispatcher.resolve.bind(dispatcher),
      action = dispatcher.action.bind(dispatcher),
      openStream = dispatcher.openStream.bind(dispatcher);
    if (this.closed || this.dispatcher) throw refuse();
    this.dispatcher = Object.freeze({ read, resolve, action, openStream });
  }
  private origin(req: Request, local: () => BrowserApiRefusal = refuse): string {
    const facts = resolveBrowserOriginFacts(req, { hostCheckInert: false });
    if (
      this.closed ||
      !this.enabled() ||
      req.method !== 'POST' ||
      !facts.hostAllowed ||
      !facts.origin ||
      !isTrustedBrowserOrigin(facts, {
        allowNoOrigin: false,
        pairSameOriginWithHost: true,
      })
    )
      throw local();
    return facts.origin;
  }
  private key(bank: WeakMap<object, string>, identity: object): string {
    let value = bank.get(identity);
    if (!value) {
      value = randomBytes(16).toString('base64url');
      bank.set(identity, value);
    }
    return value;
  }
  private enter<T>(
    acquire: (
      mark: (value: BrowserApiRefusal) => void,
      local: () => BrowserApiRefusal
    ) => Readonly<{
      auth: BrowserSemanticActorAdmission;
      checkBoundary(): void;
      onOriginalDenial?: (value: unknown) => void;
    }>,
    value: unknown,
    signal: AbortSignal,
    resolution: boolean | 'stream' | 'action',
    effect: (
      dispatcher: PrivateBrowserSemanticDispatcher,
      request: SemanticHostRequest,
      authority: OwnedSemanticReadAuthorization &
        Partial<Pick<OwnedSemanticControlAuthorization, 'input' | 'secretCurrent'>>
    ) => Promise<T>,
    owner = false,
    failureCleanup?: () => Promise<void>
  ): Promise<T> {
    const rejectEntry = (value: unknown): Promise<T> =>
      Promise.resolve().then(async () => {
        if (failureCleanup)
          try {
            await failureCleanup();
          } catch (cleanup) {
            this.first ??= { value: cleanup };
          }
        throw value;
      });
    if (this.first) return rejectEntry(this.first.value);
    if (this.closed || this.pending.size >= 16) return rejectEntry(refuse());
    const expected = new WeakSet<object>();
    let report: ((value: unknown) => void) | undefined;
    const reported = new WeakSet<object>();
    const mark = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      expected.add(value);
      if (!report || reported.has(value)) return;
      reported.add(value);
      try {
        report(value);
      } catch (original) {
        // Reporting never replaces the refusal delivered to its original caller.
        // Its own operational failure remains independently owned through close.
        this.first ??= Object.freeze({ value: original });
      }
    };
    const local = () => {
      const value = refuse();
      mark(value);
      return value;
    };
    let expired = false;
    const withinBudget = () => {
      if (expired) throw local();
    };
    // Reserve before parsing, authentication or any original receiver acquisition.
    const operation = Promise.resolve().then(async () => {
      try {
        this.throwOriginalFailure();
        if (this.closed) throw local();
        withinBudget();
        const schema =
          resolution === 'stream'
            ? streamSchema
            : resolution === 'action'
              ? actionSchema
              : resolution
                ? resolveSchema
                : requestSchema;
        const parsedRequest = schema.safeParse(value);
        if (!parsedRequest.success) {
          expected.add(parsedRequest.error);
          throw parsedRequest.error;
        }
        const request: SemanticHostRequest = parsedRequest.data;
        const captured = acquire(mark, local),
          auth = captured.auth,
          boundary = captured.checkBoundary.bind(captured);
        report = captured.onOriginalDenial;
        const refreshActor = auth.refresh.bind(auth),
          currentActor = auth.current.bind(auth);
        boundary();
        withinBudget();
        const actor = await refreshActor();
        withinBudget();

        if (!owner && !request.grant) throw local();
        const token = owner
          ? undefined
          : this.viewerGrant(
              currentActor,
              request.grant!.grantId,
              request.grant!.revision,
              request.binding,
              mark
            );
        const ownerRead = owner
          ? this.ownerSemantic(currentActor, request.binding, undefined, false, mark)
          : undefined;
        const recipientAdmission = owner
          ? undefined
          : this.admitViewer(token!, actor.owner, request.binding, mark);
        const admitted = ownerRead ?? recipientAdmission!;
        const check = () => {
          withinBudget();
          signal.throwIfAborted();
          boundary();
          const grant = ownerRead
            ? (ownerRead.current(), ownerRead)
            : this.admitViewer(token!, actor.owner, request.binding, mark);
          const current = currentActor();
          if (
            this.closed ||
            signal.aborted ||
            current?.owner !== actor.owner ||
            current.credential !== actor.credential ||
            grant.identity !== admitted.identity
          )
            throw local();
          return true;
        };
        let input: import('@dorkos/browser/server-owner').OwnedInputAuthorization | undefined;
        let ownerSecret: ReturnType<OwnedBrowserGrants['ownerSemantic']> | undefined;
        const secretCurrent = () => {
          if (!request.request || request.request.action.kind !== 'writeSecret') return false;
          if (owner) {
            if (!ownerSecret) throw local();
            ownerSecret.secretCurrent();
            return check();
          }
          this.admitPermission(
            currentActor,
            request.grant!.grantId,
            request.grant!.revision,
            request.binding,
            'browser.secretInput',
            mark
          );
          return check();
        };
        if (resolution === 'action') {
          const exact = actionSchema.parse(request),
            controller = this.controller;
          if (!controller) throw local();
          const controlGrant = owner
            ? undefined
            : this.controlGrant(
                currentActor,
                exact.grant!.grantId,
                exact.grant!.revision,
                exact.binding,
                mark
              );
          input = controller.authorization(
            currentActor,
            exact.binding,
            exact.controllerId,
            controlGrant,
            {
              propagateFailures: true,
              onOriginalDenial: (value) => mark(value),
            }
          );
        }
        if (
          owner &&
          input &&
          request.confirmSecret === true &&
          request.request?.action.kind === 'writeSecret'
        )
          ownerSecret = this.ownerSemantic(currentActor, request.binding, input, true, mark);
        const authority = Object.freeze({
          actorKey: this.key(this.actors, actor.credential),
          grantKey: this.key(this.grants, admitted.identity),
          grantRevision: recipientAdmission?.identity.grantRevision ?? 0,
          ...(input ? { input, secretCurrent } : {}),
          isCurrent: check,
          onOriginalDenial: mark,
          isOriginalRefusal: (value: unknown) =>
            !!value && typeof value === 'object' && expected.has(value),
          refresh: async () => {
            await refreshActor();
            check();
          },
        });
        await authority.refresh();
        const dispatcher = this.dispatcher;
        if (!dispatcher) throw local();
        check();
        const result = await effect(dispatcher, request, authority);
        await authority.refresh();
        check();
        return result;
      } catch (value) {
        if (
          !(value && typeof value === 'object' && expected.has(value)) &&
          !isOriginalSemanticDeliveryAbort(signal, value)
        )
          this.first ??= Object.freeze({ value });
        if (failureCleanup) {
          try {
            await failureCleanup();
          } catch (cleanup) {
            this.first ??= Object.freeze({ value: cleanup });
          }
        }
        throw value;
      }
    });
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      (value) => {
        if (
          !(value && typeof value === 'object' && expected.has(value)) &&
          !isOriginalSemanticDeliveryAbort(signal, value)
        )
          this.first ??= Object.freeze({ value });
        this.pending.delete(operation);
      }
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(local());
      }, 1000);
    });
    // Bound delivery only; the original remains in pending through natural settlement.
    return Promise.race([operation, deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }
  private httpAdmission(
    req: Request,
    res: Response,
    mark: (value: BrowserApiRefusal) => void,
    local: () => BrowserApiRefusal
  ) {
    const auth = this.captureIdentity(req, res, undefined, mark),
      admittedOrigin = this.origin(req, local);
    return Object.freeze({
      auth,
      checkBoundary: () => {
        this.throwOriginalFailure();
        if (this.origin(req, local) !== admittedOrigin) throw local();
      },
    });
  }
  private actorAdmission(original: BrowserSemanticActorAdmission, local: () => BrowserApiRefusal) {
    // Called only inside the preregistered operation; tools never supply this receiver in JSON.
    const refresh = original.refresh.bind(original),
      current = original.current.bind(original),
      onOriginalDenial = original.onOriginalDenial?.bind(original);
    return Object.freeze({
      auth: Object.freeze({ refresh, current }),
      ...(onOriginalDenial ? { onOriginalDenial } : {}),
      checkBoundary: () => {
        this.throwOriginalFailure();
        if (this.closed || !this.enabled()) throw local();
      },
    });
  }
  /** Private tools use their retained runtime-principal producer and an explicit recipient view grant. */
  readForActor(original: BrowserSemanticActorAdmission, value: unknown, signal: AbortSignal) {
    return this.enter(
      (_mark, local) => this.actorAdmission(original, local),
      value,
      signal,
      false,
      (dispatcher, request, authority) => dispatcher.read(request.binding, authority, signal)
    );
  }
  /** Private reference resolution is read-only and requires the same original principal and grant. */
  resolveForActor(original: BrowserSemanticActorAdmission, value: unknown, signal: AbortSignal) {
    return this.enter(
      (_mark, local) => this.actorAdmission(original, local),
      value,
      signal,
      true,
      (dispatcher, request, authority) => {
        const exact = resolveSchema.parse(request);
        return dispatcher.resolve(exact.binding, exact.leaseId, exact.nodeRef, authority, signal);
      }
    );
  }
  private async openOwnedStream(
    dispatcher: PrivateBrowserSemanticDispatcher,
    binding: BrowserBinding,
    leaseId: string,
    authority: OwnedSemanticReadAuthorization,
    signal: AbortSignal
  ) {
    if (this.streams.size + this.streamBirths >= 8) {
      const value = refuse();
      authority.onOriginalDenial(value);
      throw value;
    }
    this.streamBirths++;
    let close: (() => Promise<void>) | undefined;
    try {
      const original = await dispatcher.openStream(binding, leaseId, authority, signal);
      let closing: Promise<void> | undefined;
      close = () =>
        (closing ??= Promise.resolve().then(async () => {
          // Acquisition is inside the already-reserved original close; no sibling duty is skipped by a getter failure.
          const receiver = original.close.bind(original);
          await receiver();
          this.streams.delete(original);
        }));
      this.streams.set(
        original,
        Object.freeze({
          known: authority.isOriginalRefusal.bind(authority),
          close,
        })
      );
      const eventStreamId = BrowserReferenceSchema.parse(original.eventStreamId),
        next = original.next.bind(original);
      this.throwOriginalFailure();
      if (this.closed) authority.isCurrent();
      return Object.freeze({ eventStreamId, next, close });
    } catch (value) {
      if (!authority.isOriginalRefusal(value) && !isOriginalSemanticDeliveryAbort(signal, value))
        this.first ??= { value };
      try {
        if (close) await close();
      } catch (cleanup) {
        this.first ??= { value: cleanup };
      }
      throw value;
    } finally {
      this.streamBirths--;
    }
  }
  /** Each stream read re-enters genuine authentication; no HTTP or principal DTO substitutes for a receiver. */
  streamForActor(original: BrowserSemanticActorAdmission, value: unknown, signal: AbortSignal) {
    let acquired: import('@dorkos/browser/server-owner').PrivateSemanticStream | undefined;
    return this.enter(
      (_mark, local) => this.actorAdmission(original, local),
      value,
      signal,
      'stream',
      async (dispatcher, request, authority) => {
        const exact = streamSchema.parse(request);
        acquired = await this.openOwnedStream(
          dispatcher,
          exact.binding,
          exact.leaseId,
          authority,
          signal
        );
        return acquired;
      },
      false,
      async () => {
        if (acquired) await acquired.close();
      }
    );
  }
  /** Exact retained controller seat and independent view/control grants precede queued native effects. */
  actionForActor(original: BrowserSemanticActorAdmission, value: unknown, signal: AbortSignal) {
    return this.enterAction((_mark, local) => this.actorAdmission(original, local), value, signal);
  }
  /** Same origin and retained real identity precede the identical private action dispatcher. */
  action(req: Request, res: Response, value: unknown, signal: AbortSignal) {
    return this.enterAction(
      (mark, local) => this.httpAdmission(req, res, mark, local),
      value,
      signal
    );
  }
  /** HTTP stream birth retains the same actor/grant scope; every next rechecks that original scope. */
  stream(req: Request, res: Response, value: unknown, signal: AbortSignal) {
    let acquired: import('@dorkos/browser/server-owner').PrivateSemanticStream | undefined;
    return this.enter(
      (mark, local) => this.httpAdmission(req, res, mark, local),
      value,
      signal,
      'stream',
      async (dispatcher, request, authority) => {
        const exact = streamSchema.parse(request);
        acquired = await this.openOwnedStream(
          dispatcher,
          exact.binding,
          exact.leaseId,
          authority,
          signal
        );
        return acquired;
      },
      false,
      async () => {
        if (acquired) await acquired.close();
      }
    );
  }
  private enterAction(
    acquire: (
      mark: (value: BrowserApiRefusal) => void,
      local: () => BrowserApiRefusal
    ) => Readonly<{
      auth: BrowserSemanticActorAdmission;
      checkBoundary(): void;
      onOriginalDenial?: (value: unknown) => void;
    }>,
    value: unknown,
    signal: AbortSignal
  ) {
    return this.enter(acquire, value, signal, 'action', (dispatcher, request, authority) => {
      const exact = actionSchema.parse(request);
      const deny = () => {
        const error = refuse();
        authority.onOriginalDenial(error);
        return error;
      };
      if (!authority.input || !authority.secretCurrent) throw deny();
      const control: OwnedSemanticControlAuthorization = {
        ...authority,
        input: authority.input,
        secretCurrent: authority.secretCurrent,
      };
      if (
        Object.keys(exact.binding).some(
          (key) =>
            exact.binding[key as keyof typeof exact.binding] !==
            exact.request.identity[key as keyof typeof exact.binding]
        )
      )
        throw deny();
      return dispatcher.action(exact.request, control, signal);
    });
  }
  /** Fresh real server identity and exact view grant precede and follow the original native read. */
  read(req: Request, res: Response, value: unknown, signal: AbortSignal) {
    return this.enter(
      (mark, local) => this.httpAdmission(req, res, mark, local),
      value,
      signal,
      false,
      (dispatcher, request, authority) => dispatcher.read(request.binding, authority, signal)
    );
  }
  /** Resolve only a retained node reference; this method grants no focus, key, click or edit action. */
  resolve(req: Request, res: Response, value: unknown, signal: AbortSignal) {
    return this.enter(
      (mark, local) => this.httpAdmission(req, res, mark, local),
      value,
      signal,
      true,
      (dispatcher, request, authority) => {
        const exact = resolveSchema.parse(request);
        return dispatcher.resolve(exact.binding, exact.leaseId, exact.nodeRef, authority, signal);
      }
    );
  }
  /** Real HTTP consuming edge; all responses keep a final original authority check. */
  wire(
    kind: 'read' | 'action' | 'stream' | 'next' | 'close',
    req: Request,
    res: Response,
    value: unknown,
    signal: AbortSignal,
    owner = false
  ) {
    if (this.first) return Promise.reject(this.first.value);
    const wire = z
      .object({
        binding: BrowserBindingSchema,
        grant: requestSchema.shape.grant,
        leaseId: BrowserReferenceSchema.optional(),
        streamId: BrowserReferenceSchema.optional(),
        controllerId: BrowserReferenceSchema.optional(),
        request: SemanticActionV1Schema.optional(),
        confirmSecret: z.literal(true).optional(),
      })
      .strict();
    let discarded: (() => Promise<void>) | undefined;
    let delegated = false;
    const malformedWire = new WeakSet<object>();
    // Reserve before parsing body properties or acquiring a request receiver.
    const original = Promise.resolve().then(async () => {
      this.throwOriginalFailure();
      const checked = wire.safeParse(value);
      if (!checked.success) {
        malformedWire.add(checked.error);
        throw checked.error;
      }
      const parsed = checked.data;
      const mode = kind === 'action' ? 'action' : kind === 'read' ? false : 'stream';
      const request = {
        binding: parsed.binding,
        ...(parsed.grant ? { grant: parsed.grant } : {}),
        ...(parsed.confirmSecret ? { confirmSecret: parsed.confirmSecret } : {}),
        ...(mode === 'action'
          ? { controllerId: parsed.controllerId, request: parsed.request }
          : {}),
        ...(mode === 'stream' ? { leaseId: parsed.leaseId } : {}),
      };
      const streamLifetime = kind === 'stream' ? new AbortController() : undefined;
      const abortBirth = () => streamLifetime?.abort(signal.reason);
      const birth: {
        remove?: AbortSignal['removeEventListener'];
        entered: boolean;
        removed: boolean;
      } = { entered: false, removed: false };
      const removeBirth = () => {
        if (!birth.entered || birth.removed || !birth.remove) return;
        birth.removed = true;
        birth.remove('abort', abortBirth);
      };
      const cleanupBirth = async () => {
        let first: Readonly<{ value: unknown }> | undefined;
        try {
          removeBirth();
        } catch (value) {
          first = { value };
        }
        try {
          if (discarded) await discarded();
        } catch (value) {
          first ??= { value };
        }
        if (first) throw first.value;
      };
      try {
        if (streamLifetime) {
          inheritSemanticDeliveryAbort(signal, streamLifetime);
          birth.remove = signal.removeEventListener.bind(signal);
          const addBirth = signal.addEventListener.bind(signal);
          if (this.closed || this.first) {
            this.throwOriginalFailure();
            const value = refuse();
            malformedWire.add(value);
            throw value;
          }
          birth.entered = true;
          addBirth('abort', abortBirth, { once: true });
          if (signal.aborted) abortBirth();
        }
        delegated = true;
        return await this.enter(
          (mark, local) => this.httpAdmission(req, res, mark, local),
          request,
          streamLifetime?.signal ?? signal,
          mode,
          async (dispatcher, exact, authority) => {
            const denial = () => {
              const error = refuse();
              authority.onOriginalDenial(error);
              return error;
            };
            let result: unknown;
            if (kind === 'read')
              result = SemanticSnapshotV1Schema.parse(
                await dispatcher.read(exact.binding, authority, signal)
              );
            else if (kind === 'action') {
              const action = actionSchema.parse(exact);
              if (!authority.input || !authority.secretCurrent) throw denial();
              if (
                Object.keys(action.binding).some(
                  (key) =>
                    action.binding[key as keyof typeof action.binding] !==
                    action.request.identity[key as keyof typeof action.binding]
                )
              )
                throw denial();
              result = SemanticReceiptV1Schema.parse(
                await dispatcher.action(
                  action.request,
                  {
                    ...authority,
                    input: authority.input,
                    secretCurrent: authority.secretCurrent,
                  },
                  signal
                )
              );
            } else if (kind === 'stream') {
              if (this.wireStreams.size >= 8) throw denial();
              const exactStream = streamSchema.parse(exact),
                lifetime = streamLifetime!;

              const stream = await this.openOwnedStream(
                dispatcher,
                exactStream.binding,
                exactStream.leaseId,
                authority,
                lifetime.signal
              );
              const retained = stream;
              discarded = async () => {
                this.wireStreams.delete(retained.eventStreamId);
                lifetime.abort(denial());
                await retained.close();
              };
              if (this.closed || signal.aborted || this.wireStreams.has(retained.eventStreamId))
                throw denial();
              this.wireStreams.set(
                retained.eventStreamId,
                Object.freeze({
                  stream: retained,
                  actor: authority.actorKey,
                  grant: authority.grantKey,
                  cancel: () => lifetime.abort(denial()),
                })
              );
              result = { eventStreamId: retained.eventStreamId };
            } else {
              const cell = parsed.streamId ? this.wireStreams.get(parsed.streamId) : undefined;
              if (!cell || cell.actor !== authority.actorKey || cell.grant !== authority.grantKey)
                throw denial();
              if (kind === 'next') {
                const event = await cell.stream.next();
                result = event === null ? null : SemanticEventV1Schema.parse(event);
              } else {
                this.wireStreams.delete(parsed.streamId!);
                await cell.stream.close();
                result = { closed: true };
              }
            }
            const body = JSON.stringify(result);
            if (Buffer.byteLength(body, 'utf8') > 256 * 1024)
              throw new Error('SEMANTIC_WIRE_BOUND');
            let consumed = false;
            const finalCheck = authority.isCurrent.bind(authority);
            return Object.freeze({
              isOriginalRefusal: authority.isOriginalRefusal.bind(authority),
              publish: (emit: (body: string, finalCheck: () => void) => void) => {
                if (consumed || this.closed) throw denial();
                consumed = true;
                emit(body, () => {
                  if (!finalCheck()) throw denial();
                });
                if (streamLifetime) removeBirth();
              },
              discard: async () => {
                if (streamLifetime) removeBirth();
                if (discarded) await discarded();
              },
            });
          },
          owner,
          cleanupBirth
        );
      } catch (value) {
        if (!delegated && !(value && typeof value === 'object' && malformedWire.has(value)))
          this.first ??= { value };
        try {
          await cleanupBirth();
        } catch (cleanup) {
          this.first ??= { value: cleanup };
        }
        throw value;
      }
    });
    this.pending.add(original);
    void original.then(
      () => this.pending.delete(original),
      (value) => {
        this.pending.delete(original);
        if (!delegated && !(value && typeof value === 'object' && malformedWire.has(value)))
          this.first ??= { value };
      }
    );
    return original;
  }
  /** Admission closes immediately; original authentication/read/resolve promises remain joined. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      for (const cell of this.wireStreams.values())
        try {
          cell.cancel();
        } catch (value) {
          this.first ??= { value };
        }
      await Promise.allSettled([...this.pending]);
      const retained = [...this.streams];
      const originals = retained.map(([, record]) => Promise.resolve().then(record.close));
      const results = await Promise.allSettled(originals);
      for (let index = 0; index < results.length; index++) {
        const result = results[index]!;
        if (result.status === 'rejected' && !retained[index]![1].known(result.reason))
          this.first ??= { value: result.reason };
      }
      this.streams.clear();
      this.wireStreams.clear();
      this.throwOriginalFailure();
    });
    return this.closing;
  }
}
