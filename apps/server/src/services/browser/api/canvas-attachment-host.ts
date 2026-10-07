import type { BrowserLifecycleEngine } from '@dorkos/browser/server-owner';
import {
  BrowserBindingSchema,
  BrowserAttachmentSchema,
  type BrowserBinding,
  type BrowserAttachment,
  type BrowserGrant,
} from '@dorkos/shared/browser-schemas';
import type { ManagedBrowserCanvasReference } from '@dorkos/shared/schemas';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import type { CanvasService } from '../../canvas/canvas-service.js';
import { roomScope, sessionScope, SESSION_OWNER_AUTHOR } from '../../canvas/scopes.js';
import type { BrowserRegistry } from '../registry/registry.js';
import type { OwnedBrowserGrants } from './grants.js';
import { BrowserApiRefusal, type BrowserApiActor } from './service.js';

export interface BrowserCanvasAdmission {
  refresh(): Promise<BrowserApiActor>;
  current(): BrowserApiActor | undefined;
}
type Acquire = (onOriginalDenial: (value: unknown) => void) => BrowserCanvasAdmission;
type Presentation = {
  owner: string;
  attachmentId: string;
  scope: string;
  documentId?: string;
  binding: BrowserBinding;
  target: BrowserAttachment;
  grants: ReturnType<OwnedBrowserGrants['presentationOwner']>;
  closed: boolean;
  closing?: Promise<void>;
};

/** Document lifetime is private. Replayed canvas metadata cannot restore browser permission. */
export class BrowserCanvasAttachmentHost {
  private readonly presentations = new Map<string, Presentation>();
  private readonly originals = new Set<Promise<unknown>>();
  private first?: Readonly<{ value: unknown }>;
  private closed = false;
  private closing?: Promise<void>;
  private readonly unsubscribe: () => void;
  private readonly attach: BrowserRegistry['attach'];
  private readonly detach: BrowserRegistry['detach'];
  private readonly view: OwnedBrowserGrants['ownerView'];
  private readonly admitGrant: OwnedBrowserGrants['admit'];
  private readonly createGrants: OwnedBrowserGrants['presentationOwner'];
  private readonly openCanvas: CanvasService['open'];
  private readonly listTabs: BrowserLifecycleEngine['listTabs'];
  private readonly closeCanvas: CanvasService['close'];
  private readonly getCanvas: CanvasService['get'];

  constructor(
    registry: BrowserRegistry,
    grants: OwnedBrowserGrants,
    canvas: CanvasService,
    engine: BrowserLifecycleEngine,
    private readonly inScope: (actor: string, target: BrowserAttachment) => boolean
  ) {
    this.attach = registry.attach.bind(registry);
    this.detach = registry.detach.bind(registry);
    this.view = grants.ownerView.bind(grants);
    this.createGrants = grants.presentationOwner.bind(grants);
    this.admitGrant = grants.admit.bind(grants);
    this.openCanvas = canvas.open.bind(canvas);
    this.getCanvas = canvas.get.bind(canvas);
    this.closeCanvas = canvas.close.bind(canvas);
    this.listTabs = engine.listTabs.bind(engine);
    this.unsubscribe = canvas.onRemoved((scope, documentId) => {
      for (const value of this.presentations.values())
        if (value.scope === scope && value.documentId === documentId) {
          const original = this.retire(value);
          this.retain(original);
        }
    });
  }

  private retain<T>(
    original: Promise<T>,
    isDenial: (value: unknown) => boolean = () => false
  ): Promise<T> {
    this.originals.add(original);
    void original.then(
      () => this.originals.delete(original),
      (reason) => {
        if (!isDenial(reason)) this.first ??= { value: reason };
        this.originals.delete(original);
      }
    );
    return original;
  }
  private live(deny?: () => BrowserApiRefusal): void {
    if (this.first) throw this.first.value;
    if (this.closed) throw deny ? deny() : new BrowserApiRefusal('unavailable');
  }
  private sameActor(admission: BrowserCanvasAdmission, actor: BrowserApiActor): boolean {
    const actual = admission.current();
    return !!actual && actual.owner === actor.owner && actual.credential === actor.credential;
  }
  private actorReader(
    admission: BrowserCanvasAdmission,
    actor: BrowserApiActor
  ): () => BrowserApiActor | undefined {
    const current = admission.current.bind(admission);
    return () => {
      const actual = current();
      return actual && actual.owner === actor.owner && actual.credential === actor.credential
        ? actual
        : undefined;
    };
  }
  private refreshBinding(value: Presentation, deny: () => BrowserApiRefusal): void {
    const candidates = this.listTabs(
      value.binding.browserId,
      value.binding.browserGeneration
    ).filter(
      (binding) =>
        binding.browserId === value.binding.browserId &&
        binding.browserGeneration === value.binding.browserGeneration &&
        binding.tabId === value.binding.tabId
    );
    if (candidates.length !== 1) throw deny();
    const actual = Object.freeze(BrowserBindingSchema.parse(candidates[0]));
    this.live(deny);
    if (value.closed || this.presentations.get(value.attachmentId) !== value) throw deny();
    value.binding = actual;
  }
  private observe(
    admission: BrowserCanvasAdmission,
    actor: BrowserApiActor,
    value: Presentation,
    deny: () => BrowserApiRefusal,
    mark: (value: unknown) => void
  ): void {
    if (!this.sameActor(admission, actor) || !this.inScope(actor.owner, value.target)) throw deny();
    this.refreshBinding(value, deny);
    this.view(this.actorReader(admission, actor), value.binding, mark);
    this.live(deny);
    if (value.closed || this.presentations.get(value.attachmentId) !== value) throw deny();
  }

  /** Explicit authenticated owner action. Attach does not grant any recipient permission. */
  present(
    acquire: Acquire,
    bindingValue: BrowserBinding,
    targetValue: BrowserAttachment
  ): Promise<CanvasDocument> {
    this.live();
    if (this.presentations.size >= 64) throw new BrowserApiRefusal('unavailable');
    // Reserve work before original authentication or canvas producers can reenter closure.
    const denials = new Set<unknown>(),
      mark = (value: unknown) => {
        denials.add(value);
      };
    const deny = () => {
      const value = new BrowserApiRefusal('inaccessible');
      mark(value);
      return value;
    };
    const operation = Promise.resolve().then(async () => {
      this.live(deny);
      const admission = acquire(mark);
      this.live(deny);
      if (this.presentations.size >= 64) throw new BrowserApiRefusal('unavailable');
      const binding = Object.freeze(BrowserBindingSchema.parse(bindingValue)),
        target = Object.freeze(BrowserAttachmentSchema.parse(targetValue));
      const refresh = admission.refresh.bind(admission),
        current = admission.current.bind(admission);
      const captured = { refresh, current };
      const actor = await refresh();
      this.live(deny);
      if (!this.sameActor(captured, actor) || !this.inScope(actor.owner, target)) throw deny();
      this.view(this.actorReader(captured, actor), binding, mark);
      this.live(deny);
      const publication: { value?: Presentation } = {};
      const ownedGrants = this.createGrants(() => {
        const value = publication.value;
        if (!value || value.closed || !value.documentId) return false;
        const document = this.getCanvas(value.scope, value.documentId);
        return (
          !!document &&
          document.content.type === 'managed_browser' &&
          document.content.attachmentId === value.attachmentId
        );
      });
      this.live(deny);
      if (this.presentations.size >= 64) throw deny();
      const attachmentId = this.attach(
        actor.owner,
        binding.browserId,
        binding.browserGeneration,
        target
      );
      const value: Presentation = {
        owner: actor.owner,
        attachmentId,
        scope: target.kind === 'room' ? roomScope(target.roomId) : sessionScope(target.sessionId),
        binding: Object.freeze({ ...binding }),
        target: Object.freeze({ ...target }),
        grants: ownedGrants,
        closed: false,
      };
      publication.value = value;
      this.presentations.set(attachmentId, value);
      try {
        this.observe(captured, actor, value, deny, mark);
        const content: ManagedBrowserCanvasReference = {
          type: 'managed_browser',
          attachmentId,
          browserId: binding.browserId,
          browserGeneration: binding.browserGeneration,
          tabId: binding.tabId,
          ownerAuthorId: actor.owner,
          scope:
            target.kind === 'room'
              ? { kind: 'room', roomId: target.roomId }
              : { kind: 'session', sessionId: target.sessionId },
        };
        const document = this.openCanvas(
          value.scope,
          target.kind === 'session' ? SESSION_OWNER_AUTHOR : actor.owner,
          content
        );
        value.documentId = document.id;
        this.observe(captured, actor, value, deny, mark);
        const actual = this.getCanvas(value.scope, document.id);
        if (
          !actual ||
          actual.content.type !== 'managed_browser' ||
          actual.content.attachmentId !== attachmentId
        )
          throw deny();
        this.observe(captured, actor, value, deny, mark);
        return document;
      } catch (reason) {
        // Independently join owned metadata/grants without replacing the original publication cause.
        for (const result of await Promise.allSettled([this.retire(value)]))
          if (result.status === 'rejected') this.first ??= { value: result.reason };
        throw reason;
      }
    });
    return this.retain(operation, (value) => denials.has(value));
  }

  /** A human owner explicitly selects recipient permissions for this exact live document. */
  share(
    acquire: Acquire,
    attachmentId: string,
    recipient: string,
    permissions: BrowserGrant['permissions'],
    expiresAt: string
  ): Promise<BrowserGrant> {
    this.live();
    const denials = new Set<unknown>(),
      mark = (value: unknown) => {
        denials.add(value);
      };
    const deny = () => {
      const value = new BrowserApiRefusal('inaccessible');
      mark(value);
      return value;
    };
    return this.retain(
      Promise.resolve().then(async () => {
        this.live(deny);
        const admission = acquire(mark);
        this.live(deny);
        const actor = await admission.refresh();
        const value = this.presentations.get(attachmentId);
        if (!value || value.owner !== actor.owner || !value.documentId) throw deny();
        this.observe(admission, actor, value, deny, mark);
        const document = this.getCanvas(value.scope, value.documentId);
        if (
          !document ||
          document.content.type !== 'managed_browser' ||
          document.content.attachmentId !== attachmentId
        )
          throw deny();
        const grant = value.grants.issue(
          this.actorReader(admission, actor),
          value.binding,
          recipient,
          value.target,
          permissions,
          expiresAt,
          mark
        );
        try {
          this.observe(admission, actor, value, deny, mark);
          return grant;
        } catch (primary) {
          try {
            await value.grants.discard(grant.grantId, grant.grantRevision);
          } catch (failure) {
            this.first ??= { value: failure };
          }
          throw primary;
        }
      }),
      (value) => denials.has(value)
    );
  }

  /** Resolve only an existing exact document. References and replay rows supply no authority. */
  delivery(
    acquire: Acquire,
    attachmentId: string,
    grant?: { grantId: string; revision: number }
  ): Promise<{
    owner: boolean;
    binding: BrowserBinding;
    grant?: { grantId: string; revision: number };
  }> {
    this.live();
    const denials = new Set<unknown>(),
      mark = (value: unknown) => {
        denials.add(value);
      };
    const deny = () => {
      const value = new BrowserApiRefusal('inaccessible');
      mark(value);
      return value;
    };
    return this.retain(
      Promise.resolve().then(async () => {
        this.live(deny);
        const admission = acquire(mark);
        this.live(deny);
        const refresh = admission.refresh.bind(admission),
          current = admission.current.bind(admission);
        const captured = { refresh, current };
        const actor = await refresh();
        const value = this.presentations.get(attachmentId);
        if (!value || value.closed || !value.documentId) throw deny();
        if (!this.sameActor(captured, actor) || !this.inScope(actor.owner, value.target))
          throw deny();
        const document = this.getCanvas(value.scope, value.documentId);
        if (
          !document ||
          document.content.type !== 'managed_browser' ||
          document.content.attachmentId !== attachmentId
        )
          throw deny();
        this.refreshBinding(value, deny);
        const selected =
          grant ??
          (actor.owner === value.owner ? undefined : value.grants.recipientView(actor.owner));
        if (selected) {
          if (!value.grants.owns(selected.grantId, selected.revision)) throw deny();
          this.admitGrant(
            this.actorReader(captured, actor),
            selected.grantId,
            selected.revision,
            value.binding,
            'browser.view',
            mark
          );
        } else {
          if (actor.owner !== value.owner) throw deny();
          this.view(this.actorReader(captured, actor), value.binding, mark);
        }
        if (!this.sameActor(captured, actor)) throw deny();
        this.live(deny);
        if (value.closed || this.presentations.get(attachmentId) !== value) throw deny();
        return Object.freeze({
          owner: actor.owner === value.owner,
          binding: value.binding,
          ...(selected ? { grant: Object.freeze({ ...selected }) } : {}),
        });
      }),
      (value) => denials.has(value)
    );
  }

  /** Remove only the authenticated owner's presentation; the browser continues running. */
  detachPresentation(acquire: Acquire, attachmentId: string): Promise<void> {
    this.live();
    const denials = new Set<unknown>(),
      mark = (value: unknown) => {
        denials.add(value);
      };
    const deny = () => {
      const value = new BrowserApiRefusal('inaccessible');
      mark(value);
      return value;
    };
    return this.retain(
      Promise.resolve().then(async () => {
        this.live(deny);
        const admission = acquire(mark);
        this.live(deny);
        const actor = await admission.refresh();
        const value = this.presentations.get(attachmentId);
        if (!value || value.owner !== actor.owner) throw deny();
        this.observe(admission, actor, value, deny, mark);
        const retired = this.retire(value);
        const removed = Promise.resolve().then(() => {
          if (value.documentId) this.closeCanvas(value.scope, value.documentId);
        });
        let failure: Readonly<{ value: unknown }> | undefined;
        for (const result of await Promise.allSettled([retired, removed]))
          if (result.status === 'rejected') failure ??= { value: result.reason };
        if (failure) throw failure.value;
      }),
      (value) => denials.has(value)
    );
  }

  private retire(value: Presentation): Promise<void> {
    value.closed = true;
    return (value.closing ??= Promise.resolve().then(async () => {
      const duties = [
        Promise.resolve().then(() => value.grants.close()),
        Promise.resolve().then(() => this.detach(value.owner, value.attachmentId)),
      ];
      let first: Readonly<{ value: unknown }> | undefined;
      for (const result of await Promise.allSettled(duties))
        if (result.status === 'rejected') first ??= { value: result.reason };
      if (first) throw first.value;
      this.presentations.delete(value.attachmentId);
    }));
  }

  /** Callback-free final HTTP publication fence after original authentication/origin producers. */
  publicationCurrent(
    attachmentId: string,
    owner: string,
    grant?: { grantId: string; revision: number }
  ): boolean {
    const value = this.presentations.get(attachmentId);
    return (
      !this.closed &&
      !this.first &&
      !!value &&
      !value.closed &&
      (grant ? value.grants.owns(grant.grantId, grant.revision) : value.owner === owner)
    );
  }

  faulted(): boolean {
    return !!this.first;
  }

  /** Private router selection only; the consuming command still authenticates its caller. */
  ownsAttachment(attachmentId: string): boolean {
    const value = this.presentations.get(attachmentId);
    return !this.closed && !this.first && !!value && !value.closed;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Fence every document synchronously; all original removals and reset duties are joined below.
    for (const value of this.presentations.values()) value.closed = true;
    return (this.closing = Promise.resolve().then(async () => {
      const duties = [
        Promise.resolve().then(() => this.unsubscribe()),
        ...[...this.presentations.values()].map((value) => this.retire(value)),
      ];
      for (const result of await Promise.allSettled(duties))
        if (result.status === 'rejected') this.first ??= { value: result.reason };
      // Each retained operation's own original observer distinguishes its exact local denial.
      // Joining does not reclassify a known closed admission as an operational failure.
      while (this.originals.size) await Promise.allSettled([...this.originals]);
      // Late acquisition work may have published an owned association before observing closure.
      for (const result of await Promise.allSettled(
        [...this.presentations.values()].map((value) => this.retire(value))
      ))
        if (result.status === 'rejected') this.first ??= { value: result.reason };
      if (this.first) throw this.first.value;
    }));
  }
}
