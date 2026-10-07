import { randomBytes } from 'node:crypto';
import type {
  BrowserLifecycleEngine,
  PrivateBrowserBirthOwner,
  PrivateBrowserRetirementReceiver,
} from '@dorkos/browser/server-owner';
import {
  BrowserBindingSchema,
  BrowserGrantSchema,
  BrowserGrantChangeRequestSchema,
  type BrowserBinding,
  type BrowserGrant,
  type BrowserAttachment,
  type BrowserGrantChangeRequest,
} from '@dorkos/shared/browser-schemas';
import type { BrowserRegistry } from '../registry/registry.js';
import type { RegistryMode } from '../registry/store.js';
import { BrowserGrantExpiry } from './grant-expiry.js';
import { BrowserApiRefusal, type BrowserApiActor } from './service.js';

const originalRefusals = new WeakSet<object>();
/** Read-only provenance of an original local denial; callback-created typed errors are not denials. */
export function isOriginalBrowserGrantRefusal(error: unknown): error is BrowserApiRefusal {
  return !!error && typeof error === 'object' && originalRefusals.has(error);
}
function originalGrantRefusal(reason: BrowserApiRefusal['reason']): BrowserApiRefusal {
  const error = new BrowserApiRefusal(reason);
  originalRefusals.add(error);
  return error;
}

declare const controllerGrantBrand: unique symbol;
export type BrowserControllerGrant = { readonly [controllerGrantBrand]: true };

declare const viewerGrantBrand: unique symbol;
export type BrowserViewerGrant = { readonly [viewerGrantBrand]: true };

type Permission = BrowserGrant['permissions'][number];
type Original = {
  receiver: PrivateBrowserRetirementReceiver;
  owner: string;
  generation: number;
  ordinary: () => boolean;
  current: () => boolean;
  retire: () => Promise<unknown>;
  retired: boolean;
};
type PresentationLifetime = {
  readonly documentCurrent: () => boolean;
  closed: boolean;
  readonly grants: Set<Grant>;
  readonly originals: Set<Promise<void>>;
  closing?: Promise<void>;
};
type Grant = {
  presentation?: PresentationLifetime;
  value: BrowserGrant;
  binding: BrowserBinding;
  owner: string;
  recipient: string;
  original: Original;
};

/** Private grant authority retains original producers; wire projections carry no access capability. */
export class OwnedBrowserGrants {
  private readonly controllerGrants = new WeakMap<
    BrowserControllerGrant,
    {
      readActor: () => BrowserApiActor | undefined;
      grant: Grant;
      revision: number;
    }
  >();
  private readonly viewerGrants = new WeakMap<
    BrowserViewerGrant,
    {
      readActor: () => BrowserApiActor | undefined;
      grant: Grant;
      revision: number;
    }
  >();
  private readonly originals = new Map<string, Original>();
  private readonly grants = new Map<string, Grant>();
  private readonly expiry: BrowserGrantExpiry;
  private expiryClosed = false;
  private resetGrant?: (identity: object) => Promise<void>;
  private readonly revocations = new Set<Promise<void>>();
  private listTabs?: BrowserLifecycleEngine['listTabs'];
  private readonly registryBirth: BrowserRegistry['birthOwner'];

  /** Capture server authority and scope admission; neither dependency comes from request data. */
  constructor(
    registry: Pick<BrowserRegistry, 'birthOwner'>,
    private readonly inScope: (actor: string, attachment: BrowserAttachment) => boolean,
    private readonly enabled: () => boolean = () => false,
    private readonly now: () => number = Date.now
  ) {
    this.registryBirth = registry.birthOwner.bind(registry);
    this.expiry = new BrowserGrantExpiry((identity) => this.retainReset(identity), this.now);
  }

  /** Bind the original private reset owner before issuing grants; never supplied by a wire request. */
  bindController(controller: { revokeGrant(identity: object): Promise<void> }): void {
    if (this.resetGrant || this.grants.size) throw originalGrantRefusal('inaccessible');
    this.resetGrant = controller.revokeGrant.bind(controller);
  }

  pendingRevocations(): number {
    return this.revocations.size;
  }

  private retainReset(identity: object): Promise<void> | undefined {
    if (!this.resetGrant) return;
    const operation = this.resetGrant(identity);
    this.revocations.add(operation);
    void operation.then(
      () => this.revocations.delete(operation),
      () => this.revocations.delete(operation)
    );
    return operation;
  }

  /** Original timer custody ends at host shutdown; native shutdown remains the original engine owner's duty. */
  closeExpiry(): void {
    this.expiryClosed = true;
    this.expiry.close();
  }

  /** Install exactly the engine constructed with this owner's callback, before its first open. */
  bindEngine(engine: BrowserLifecycleEngine): void {
    if (this.listTabs || this.originals.size) throw originalGrantRefusal('inaccessible');
    this.listTabs = engine.listTabs.bind(engine);
  }

  /** Trusted engine construction wraps registry registration before any native acquisition. */
  birthOwner(
    owner: string,
    mode: RegistryMode,
    network?: PrivateBrowserBirthOwner['network'],
    input?: PrivateBrowserBirthOwner['input'],
    capture?: PrivateBrowserBirthOwner['capture']
  ): PrivateBrowserBirthOwner {
    const registry = this.registryBirth(owner, mode, network);
    const register = registry.registerBirth.bind(registry),
      refuse = registry.refuseBirth.bind(registry);
    return Object.freeze({
      ...(network ? { network } : {}),
      ...(input ? { input } : {}),
      ...(capture ? { capture } : {}),
      registerBirth: (receiver: PrivateBrowserRetirementReceiver) => {
        if (!this.listTabs || this.originals.has(receiver.browserId))
          throw originalGrantRefusal('inaccessible');
        register(receiver);
        const original: Original = {
          receiver,
          owner,
          generation: receiver.browserGeneration,
          ordinary: receiver.isOrdinary.bind(receiver),
          current: receiver.isAuthorityCurrent.bind(receiver),
          retire: receiver.authorityRevoked.bind(receiver),
          retired: false,
        };
        this.originals.set(receiver.browserId, original);
        void receiver.observation.then(
          () => {
            original.retired = true;
          },
          () => {
            original.retired = true;
          }
        );
      },
      refuseBirth: (receiver: PrivateBrowserRetirementReceiver) => {
        refuse(receiver);
        const original = this.originals.get(receiver.browserId);
        if (original && original.receiver === receiver) original.retired = true;
      },
    });
  }

  private actor(
    read: () => BrowserApiActor | undefined,
    refusal = originalGrantRefusal
  ): { owner: string; check: () => void } {
    if (this.expiryClosed || !this.enabled()) throw refusal('unavailable');
    const actor = read();
    if (!actor) throw refusal('unauthenticated');
    const owner = actor.owner,
      credential = actor.credential;
    return {
      owner,
      check: () => {
        if (this.expiryClosed || !this.enabled()) throw refusal('unavailable');
        const current = read();
        if (!current || current.owner !== owner || current.credential !== credential)
          throw refusal('unauthenticated');
      },
    };
  }

  private current(
    binding: BrowserBinding,
    expected?: Original,
    refusal = originalGrantRefusal
  ): Original {
    const original = this.originals.get(binding.browserId);
    if (
      !original ||
      (expected && original !== expected) ||
      original.generation !== binding.browserGeneration ||
      original.retired ||
      !original.ordinary() ||
      !original.current()
    )
      throw refusal('inaccessible');
    const tabs = this.listTabs!(binding.browserId, binding.browserGeneration);
    const exact = tabs.some((tab) =>
      Object.keys(binding).every(
        (key) => tab[key as keyof BrowserBinding] === binding[key as keyof BrowserBinding]
      )
    );
    if (!exact || original.retired || !original.ordinary() || !original.current())
      throw refusal('inaccessible');
    return original;
  }

  private currentGrantTab(grant: Grant): BrowserBinding {
    const original = grant.original;
    const tab = this.listTabs!(grant.binding.browserId, grant.binding.browserGeneration).find(
      (value) =>
        value.browserId === grant.binding.browserId &&
        value.browserGeneration === grant.binding.browserGeneration &&
        value.tabId === grant.binding.tabId
    );
    if (!tab) throw originalGrantRefusal('inaccessible');
    const binding = BrowserBindingSchema.parse(tab);
    this.current(binding, original);
    return binding;
  }

  /** Capture one presentation's revocable recipient grants. Closing it never retires its browser. */
  presentationOwner(documentCurrent: () => boolean = () => true) {
    return this.scopeOwner(documentCurrent);
  }

  /** Constructor-private grants remain subject to the exact retained original scope predicate. */
  scopeOwner(documentCurrent: () => boolean) {
    const lifetime: PresentationLifetime = {
      documentCurrent,
      closed: false,
      grants: new Set(),
      originals: new Set(),
    };
    const issue = this.issueOriginal.bind(this);
    return Object.freeze({
      issue: (
        readActor: () => BrowserApiActor | undefined,
        binding: BrowserBinding,
        recipient: string,
        attachment: BrowserAttachment,
        permissions: Permission[],
        expiresAt: string,
        onOriginalDenial?: (value: BrowserApiRefusal) => void
      ) => {
        if (lifetime.closed || lifetime.grants.size >= 64) {
          const refusal = originalGrantRefusal('inaccessible');
          onOriginalDenial?.(refusal);
          throw refusal;
        }
        const value = issue(
          readActor,
          binding,
          recipient,
          attachment,
          permissions,
          expiresAt,
          onOriginalDenial,
          lifetime
        );
        const original = this.grants.get(value.grantId);
        if (!original) throw originalGrantRefusal('inaccessible');
        original.presentation = lifetime;
        lifetime.grants.add(original);
        // All fallible issuance callbacks precede this exact private lifetime fence.
        if (lifetime.closed) {
          const cleanup = this.retirePresentationGrant(original);
          if (cleanup) void cleanup.catch(() => {}); // close joins the exact retained original.
          throw originalGrantRefusal('inaccessible');
        }
        return value;
      },
      discard: (grantId: string, revision: number) => {
        const original = this.grants.get(grantId);
        if (
          !original ||
          original.presentation !== lifetime ||
          !lifetime.grants.has(original) ||
          original.value.grantRevision !== revision
        )
          throw originalGrantRefusal('inaccessible');
        return this.retirePresentationGrant(original);
      },
      close: () => {
        lifetime.closed = true;
        return (lifetime.closing ??= Promise.resolve().then(async () => {
          const duties = [...lifetime.grants].map((grant) =>
            Promise.resolve().then(() => this.retirePresentationGrant(grant))
          );
          let first: Readonly<{ value: unknown }> | undefined;
          for (const returned of await Promise.allSettled(duties))
            if (returned.status === 'rejected') first ??= { value: returned.reason };
          for (const returned of await Promise.allSettled([...lifetime.originals]))
            if (returned.status === 'rejected') first ??= { value: returned.reason };
          if (first) throw first.value;
        }));
      },
      current: () => !lifetime.closed,
      recipientView: (recipient: string) => {
        if (lifetime.closed) return;
        for (const grant of lifetime.grants)
          if (
            grant.recipient === recipient &&
            grant.value.revokedAt === null &&
            grant.value.permissions.includes('browser.view')
          )
            return Object.freeze({
              grantId: grant.value.grantId,
              revision: grant.value.grantRevision,
            });
        return undefined;
      },
      owns: (grantId: string, revision: number) => {
        const original = this.grants.get(grantId);
        return (
          !lifetime.closed &&
          !!original &&
          original.presentation === lifetime &&
          lifetime.grants.has(original) &&
          original.value.grantRevision === revision &&
          original.value.revokedAt === null
        );
      },
    });
  }

  private retirePresentationGrant(grant: Grant): Promise<void> | undefined {
    if (grant.value.revokedAt !== null) return;
    const identity = grant.value;
    grant.value = Object.freeze({
      ...grant.value,
      revokedAt: new Date(this.now()).toISOString(),
    });
    this.expiry.remove(grant);
    const original = this.retainReset(identity);
    if (original) grant.presentation?.originals.add(original);
    return original;
  }

  /** An owner explicitly shares permissions with a scope member on a genuinely current tab. */
  issue(
    readActor: () => BrowserApiActor | undefined,
    bindingValue: BrowserBinding,
    recipient: string,
    attachment: BrowserAttachment,
    permissions: Permission[],
    expiresAt: string,
    onOriginalDenial?: (value: BrowserApiRefusal) => void
  ): BrowserGrant {
    return this.issueOriginal(
      readActor,
      bindingValue,
      recipient,
      attachment,
      permissions,
      expiresAt,
      onOriginalDenial
    );
  }

  private issueOriginal(
    readActor: () => BrowserApiActor | undefined,
    bindingValue: BrowserBinding,
    recipient: string,
    attachment: BrowserAttachment,
    permissions: Permission[],
    expiresAt: string,
    onOriginalDenial?: (value: BrowserApiRefusal) => void,
    presentation?: PresentationLifetime
  ): BrowserGrant {
    const refusal = (reason: BrowserApiRefusal['reason']) => {
      const value = originalGrantRefusal(reason);
      onOriginalDenial?.(value);
      return value;
    };
    const checkPresentation = () => {
      // Original actor getters may synchronously close this private presentation.
      // Stop before consulting further producers; later authority fences still apply.
      if (presentation?.closed === true) throw refusal('inaccessible');
    };
    const actor = this.actor(readActor, refusal);
    checkPresentation();
    const binding = Object.freeze(BrowserBindingSchema.parse(bindingValue));
    const original = this.current(binding, undefined, refusal);
    if (original.owner !== actor.owner) throw refusal('inaccessible');
    const value = BrowserGrantSchema.parse({
      grantId: randomBytes(16).toString('base64url'),
      grantRevision: 0,
      tabId: binding.tabId,
      attachment,
      permissions,
      expiresAt,
      revokedAt: null,
    });
    Object.freeze(value.attachment);
    Object.freeze(value.permissions);
    Object.freeze(value);
    if (
      Date.parse(value.expiresAt) <= this.now() ||
      !this.inScope(actor.owner, value.attachment) ||
      !this.inScope(recipient, value.attachment)
    )
      throw refusal('inaccessible');
    actor.check();
    checkPresentation();
    this.current(binding, original, refusal);
    const ownerInScope = this.inScope(actor.owner, value.attachment);
    const recipientInScope = this.inScope(recipient, value.attachment);
    const finalTime = this.now();
    const documentCurrent = presentation ? presentation.documentCurrent() : true;
    actor.check();
    if (
      !documentCurrent ||
      presentation?.closed === true ||
      !ownerInScope ||
      !recipientInScope ||
      !Number.isFinite(finalTime) ||
      Date.parse(value.expiresAt) <= finalTime ||
      original.retired ||
      this.originals.get(binding.browserId) !== original ||
      this.grants.has(value.grantId)
    )
      throw refusal('inaccessible');
    const grant: Grant = {
      value,
      binding,
      owner: actor.owner,
      recipient,
      original,
      ...(presentation ? { presentation } : {}),
    };
    this.grants.set(value.grantId, grant);
    this.expiry.set(grant, value, Date.parse(value.expiresAt), finalTime);
    return BrowserGrantSchema.parse(value);
  }

  /** Check exact revision, original lifetime, actor, scope and permission before each delivery/step. */
  admit(
    readActor: () => BrowserApiActor | undefined,
    grantId: string,
    revision: number,
    bindingValue: BrowserBinding,
    permission: Permission,
    onOriginalDenial?: (value: BrowserApiRefusal) => void
  ): void {
    // Only decisions made by this invocation report a denial. Original callback exceptions are never reported.
    const refusal = (reason: Parameters<typeof originalGrantRefusal>[0]) => {
      const value = originalGrantRefusal(reason);
      onOriginalDenial?.(value);
      return value;
    };
    const actor = this.actor(readActor, refusal),
      binding = BrowserBindingSchema.parse(bindingValue),
      grant = this.grants.get(grantId);
    if (
      !grant ||
      grant.presentation?.closed === true ||
      grant.recipient !== actor.owner ||
      grant.value.grantRevision !== revision ||
      grant.value.revokedAt !== null ||
      Date.parse(grant.value.expiresAt) <= this.now() ||
      !grant.value.permissions.includes(permission) ||
      binding.browserId !== grant.binding.browserId ||
      binding.browserGeneration !== grant.binding.browserGeneration ||
      binding.tabId !== grant.binding.tabId
    )
      throw refusal('inaccessible');
    if (
      !this.inScope(actor.owner, grant.value.attachment) ||
      !this.inScope(grant.owner, grant.value.attachment)
    )
      throw refusal('inaccessible');
    actor.check();
    this.current(binding, grant.original, refusal);
    const finalTime = this.now();
    const documentCurrent = grant.presentation ? grant.presentation.documentCurrent() : true;
    actor.check();
    const presentationClosed = () => grant.presentation?.closed === true;
    // After the last actor callback, compare retained state without any new authority callbacks.
    if (
      !documentCurrent ||
      this.grants.get(grantId) !== grant ||
      presentationClosed() ||
      grant.value.grantRevision !== revision ||
      grant.value.revokedAt !== null ||
      grant.original.retired ||
      this.originals.get(binding.browserId) !== grant.original ||
      !Number.isFinite(finalTime) ||
      Date.parse(grant.value.expiresAt) <= finalTime
    )
      throw refusal('inaccessible');
  }

  /** Issue an opaque private control context only after actual recipient/revision admission. */
  controllerGrant(
    readActor: () => BrowserApiActor | undefined,
    grantId: string,
    revision: number,
    binding: BrowserBinding,
    onOriginalDenial?: (value: BrowserApiRefusal) => void
  ): BrowserControllerGrant {
    this.admit(readActor, grantId, revision, binding, 'browser.control', onOriginalDenial);
    const grant = this.grants.get(grantId)!;
    const token = Object.freeze(Object.create(null)) as BrowserControllerGrant;
    this.controllerGrants.set(token, { readActor, grant, revision });
    return token;
  }

  /** Private validator returns actual original resource owner and exact admitted grant revision identity. */
  admitController(
    token: BrowserControllerGrant,
    actorOwner: string,
    binding: BrowserBinding,
    onOriginalDenial?: (value: BrowserApiRefusal) => void
  ) {
    const context = this.controllerGrants.get(token);
    if (!context || context.grant.recipient !== actorOwner) {
      const value = originalGrantRefusal('inaccessible');
      onOriginalDenial?.(value);
      throw value;
    }
    const { grant, revision, readActor } = context;
    this.admit(
      readActor,
      grant.value.grantId,
      revision,
      binding,
      'browser.control',
      onOriginalDenial
    );
    if (this.grants.get(grant.value.grantId) !== grant) {
      const value = originalGrantRefusal('inaccessible');
      onOriginalDenial?.(value);
      throw value;
    }
    return Object.freeze({ owner: grant.owner, identity: grant.value });
  }

  /** Opaque view context is separate from control authority; JSON cannot issue this capability. */
  viewerGrant(
    readActor: () => BrowserApiActor | undefined,
    grantId: string,
    revision: number,
    binding: BrowserBinding,
    onOriginalDenial?: (value: BrowserApiRefusal) => void
  ): BrowserViewerGrant {
    this.admit(readActor, grantId, revision, binding, 'browser.view', onOriginalDenial);
    const grant = this.grants.get(grantId)!;
    const token = Object.freeze(Object.create(null)) as BrowserViewerGrant;
    this.viewerGrants.set(token, { readActor, grant, revision });
    return token;
  }

  /** Return only the original owner and exact internal revision identity after view admission. */
  admitViewer(
    token: BrowserViewerGrant,
    actorOwner: string,
    binding: BrowserBinding,
    onOriginalDenial?: (value: BrowserApiRefusal) => void
  ) {
    const refusal = (reason: Parameters<typeof originalGrantRefusal>[0]) => {
      const value = originalGrantRefusal(reason);
      onOriginalDenial?.(value);
      return value;
    };
    const context = this.viewerGrants.get(token);
    if (!context || context.grant.recipient !== actorOwner) throw refusal('inaccessible');
    const { grant, revision, readActor } = context;
    this.admit(readActor, grant.value.grantId, revision, binding, 'browser.view', onOriginalDenial);
    if (this.grants.get(grant.value.grantId) !== grant) throw refusal('inaccessible');
    return Object.freeze({ owner: grant.owner, identity: grant.value });
  }

  /** Owner view authority comes from the exact original engine registration, not a status DTO. */
  ownerView(
    readActor: () => BrowserApiActor | undefined,
    bindingValue: BrowserBinding,
    onOriginalDenial?: (value: BrowserApiRefusal) => void
  ) {
    const refusal = (reason: BrowserApiRefusal['reason']) => {
      const value = originalGrantRefusal(reason);
      onOriginalDenial?.(value);
      return value;
    };
    const binding = Object.freeze(BrowserBindingSchema.parse(bindingValue));
    const actor = this.actor(readActor, refusal);
    const original = this.current(binding, undefined, refusal);
    if (original.owner !== actor.owner) throw refusal('inaccessible');
    this.current(binding, original, refusal);
    actor.check();
    if (original.retired || this.originals.get(binding.browserId) !== original)
      throw refusal('inaccessible');
    return Object.freeze({
      owner: original.owner,
      identity: original.receiver,
    });
  }

  /** Constructor-private owner semantic permission. No public grant or scope attachment is invented. */
  ownerSemantic(
    readActor: () => BrowserApiActor | undefined,
    value: BrowserBinding,
    control: import('@dorkos/browser/server-owner').OwnedInputAuthorization | undefined,
    secretIntent: boolean,
    onOriginalDenial?: (value: BrowserApiRefusal) => void
  ) {
    const deny = (reason: BrowserApiRefusal['reason']) => {
      const error = originalGrantRefusal(reason);
      onOriginalDenial?.(error);
      return error;
    };
    const binding = Object.freeze(BrowserBindingSchema.parse(value)),
      actor = this.actor(readActor, deny),
      original = this.current(binding, undefined, deny);
    if (original.owner !== actor.owner) throw deny('inaccessible');
    const inputCurrent = control?.isCurrent.bind(control);
    const current = () => {
      actor.check();
      this.current(binding, original, deny);
      if (
        original.owner !== actor.owner ||
        original.retired ||
        this.originals.get(binding.browserId) !== original
      )
        throw deny('inaccessible');
      return true;
    };
    const secretCurrent = () => {
      if (!secretIntent || !inputCurrent) throw deny('inaccessible');
      if (!inputCurrent()) throw deny('inaccessible');
      return current();
    };
    current();
    return Object.freeze({
      owner: original.owner,
      identity: original.receiver,
      current,
      secretCurrent,
    });
  }

  /** Actual committed membership loss selects only stored scope grants, then rechecks original membership. */
  scopeRemoved(attachment: BrowserAttachment, actorId: string): void {
    if (this.expiryClosed) return;
    for (const grant of this.grants.values()) {
      if (
        grant.value.revokedAt !== null ||
        grant.value.attachment.kind !== attachment.kind ||
        JSON.stringify(grant.value.attachment) !== JSON.stringify(attachment) ||
        (grant.owner !== actorId && grant.recipient !== actorId)
      )
        continue;
      let lost = true;
      try {
        lost =
          !this.inScope(grant.owner, grant.value.attachment) ||
          !this.inScope(grant.recipient, grant.value.attachment);
      } catch {
        /* Unknown membership cannot keep control. */
      }
      if (!lost || grant.value.revokedAt !== null) continue;
      const identity = grant.value;
      grant.value = Object.freeze({
        ...grant.value,
        revokedAt: new Date(this.now()).toISOString(),
      });
      this.expiry.remove(grant);
      this.retainReset(identity);
    }
  }

  /** Owner revision edits invalidate old tickets immediately; no input is dispatched here. */
  change(
    readActor: () => BrowserApiActor | undefined,
    requestValue: BrowserGrantChangeRequest
  ): BrowserGrant {
    const request = BrowserGrantChangeRequestSchema.parse(requestValue),
      actor = this.actor(readActor),
      grant = this.grants.get(request.grantId);
    if (
      !grant ||
      grant.owner !== actor.owner ||
      grant.value.grantRevision !== request.expectedRevision ||
      grant.value.revokedAt !== null ||
      request.expectedRevision === Number.MAX_SAFE_INTEGER ||
      Date.parse(request.expiresAt) <= this.now()
    )
      throw originalGrantRefusal('inaccessible');
    actor.check();
    this.currentGrantTab(grant);
    if (
      this.grants.get(request.grantId) !== grant ||
      grant.value.grantRevision !== request.expectedRevision ||
      grant.value.revokedAt !== null
    )
      throw originalGrantRefusal('inaccessible');
    actor.check();
    this.currentGrantTab(grant);
    const originalIdentity = grant.value;
    const ownerInScope = this.inScope(actor.owner, originalIdentity.attachment);
    const recipientInScope = this.inScope(grant.recipient, originalIdentity.attachment);
    const finalTime = this.now();
    actor.check();
    if (
      !ownerInScope ||
      !recipientInScope ||
      grant.value !== originalIdentity ||
      !Number.isFinite(finalTime) ||
      Date.parse(request.expiresAt) <= finalTime ||
      Date.parse(grant.value.expiresAt) <= finalTime ||
      this.grants.get(request.grantId) !== grant ||
      grant.original.retired ||
      this.originals.get(grant.binding.browserId) !== grant.original ||
      grant.value.grantRevision !== request.expectedRevision ||
      grant.value.revokedAt !== null
    )
      throw originalGrantRefusal('inaccessible');
    const priorIdentity = grant.value;
    grant.value = BrowserGrantSchema.parse({
      ...grant.value,
      grantRevision: request.expectedRevision + 1,
      permissions: request.permissions,
      expiresAt: request.expiresAt,
    });
    Object.freeze(grant.value.attachment);
    Object.freeze(grant.value.permissions);
    Object.freeze(grant.value);
    this.expiry.set(grant, grant.value, Date.parse(grant.value.expiresAt), finalTime);
    this.retainReset(priorIdentity);
    return BrowserGrantSchema.parse(grant.value);
  }

  /** Revoke synchronously; a bound controller retains exact resets, otherwise retire the original. */
  revoke(
    readActor: () => BrowserApiActor | undefined,
    grantId: string,
    revision: number
  ): BrowserGrant {
    const actor = this.actor(readActor),
      grant = this.grants.get(grantId);
    if (
      !grant ||
      grant.owner !== actor.owner ||
      grant.value.grantRevision !== revision ||
      revision === Number.MAX_SAFE_INTEGER
    )
      throw originalGrantRefusal('inaccessible');
    actor.check();
    const identity = grant.value;
    grant.value = BrowserGrantSchema.parse({
      ...grant.value,
      grantRevision: revision + 1,
      revokedAt: new Date(this.now()).toISOString(),
    });
    Object.freeze(grant.value.attachment);
    Object.freeze(grant.value.permissions);
    Object.freeze(grant.value);
    this.expiry.remove(grant);
    if (this.resetGrant) {
      this.retainReset(identity);
      return BrowserGrantSchema.parse(grant.value);
    }
    const original = grant.original;
    if (!original.retired) {
      original.retired = true;
      // Retain the actual observation through the registry's original callback; never infer cleanup.
      try {
        void original.retire().catch(() => {});
      } catch {
        /* The synchronous admission fence persists. */
      }
    }
    return BrowserGrantSchema.parse(grant.value);
  }
}
