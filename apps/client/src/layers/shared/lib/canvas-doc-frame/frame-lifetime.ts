/** One host observation shared by independent protocols; page reports may only retire it. */
import {
  CanvasDocIncarnationSchema,
  parseCanvasDocWire,
  sameCanvasDocIncarnation,
  type CanvasDocIncarnation,
} from '@dorkos/shared/canvas-doc-frame-wire';
/** Immutable host facts. The Window and transport references are identities, not serialized data. */
export interface FrameHostContext {
  frame: Window | null;
  documentId: string;
  resolvedSource: string | null;
  logicalUrl: string;
  reloadKey: string;
  sessionId: string | null;
  eligibility: 'served-document' | 'preview-listener' | null;
  exactOrigin: string | null;
  transportOwner: object;
  publisherEpoch: number;
}
/** Only a real host load can produce a loaded observation; WindowProxy equality is insufficient. */
export interface FrameObservation extends Readonly<FrameHostContext> {
  readonly token: number;
  readonly loaded: boolean;
}
/** Host-issued Doc binding, separate from the reusable observation/DevTools lifetime. */
export interface FrameDocBinding {
  readonly observation: FrameObservation;
  readonly incarnation: Readonly<CanvasDocIncarnation>;
  readonly scope: string;
}
type Cleanup = () => unknown;
/** Synchronous retirement invalidates admission before independently draining sibling cleanups. */
export class FrameLifetimeController {
  private current: FrameObservation | null = null;
  private token = 0;
  private retiring = false;
  private readonly subscribers = new Set<Cleanup>();
  private readonly resources = new Map<FrameObservation, Set<Cleanup>>();
  private doc: FrameDocBinding | null = null;
  private readonly docClaims = new WeakMap<FrameDocBinding, object>();
  private retiringDoc = false;
  private readonly docResources = new Map<FrameDocBinding, Set<Cleanup>>();
  private readonly bindings = new WeakSet<object>();
  /** Snapshot current host observation; absence never acquires a Doc binding. */
  getCurrent(): FrameObservation | null {
    return this.current;
  }
  /** Host-only context capture. Changes retire protocols before replacing the observation. */
  observeHostContext(context: FrameHostContext): FrameObservation | null {
    if (this.retiring) return null;
    if (
      !context.transportOwner ||
      typeof context.transportOwner !== 'object' ||
      !Number.isSafeInteger(context.publisherEpoch) ||
      context.publisherEpoch < 0
    )
      throw new Error('Explicit transport owner and epoch required.');
    const keys: (keyof FrameHostContext)[] = [
      'frame',
      'documentId',
      'resolvedSource',
      'logicalUrl',
      'reloadKey',
      'sessionId',
      'eligibility',
      'exactOrigin',
      'transportOwner',
      'publisherEpoch',
    ];
    if (
      keys.some((key) => !Object.hasOwn(context, key)) ||
      typeof context.documentId !== 'string' ||
      !context.documentId ||
      typeof context.logicalUrl !== 'string' ||
      typeof context.reloadKey !== 'string'
    )
      throw new Error('Complete host context required.');
    const old = this.current;
    if (old && keys.every((key) => Object.is(old[key], context[key]))) return old;
    this.retire();
    this.current = Object.freeze({ ...context, token: this.token, loaded: false });
    return this.current;
  }
  /** Actual host onLoad, captured against its still-current context, establishes a fresh token. */
  observeLoaded(observation: FrameObservation): FrameObservation | null {
    if (this.retiring || this.current !== observation || !observation.frame) return null;
    this.retire();
    this.current = Object.freeze({ ...observation, token: this.token, loaded: true });
    return this.current;
  }
  /** Clear first, advance epoch, then drain every independently caught callback and resource. */
  retire(): void {
    if (this.retiring) return;
    const old = this.current;
    this.current = null;
    const oldDoc = this.doc;
    this.doc = null;
    this.token++;
    this.retiring = true;
    const callbacks = [
      ...(old ? (this.resources.get(old) ?? []) : []),
      ...(oldDoc ? (this.docResources.get(oldDoc) ?? []) : []),
      ...this.subscribers,
    ];
    if (oldDoc) this.docResources.delete(oldDoc);
    if (old) this.resources.delete(old);
    try {
      for (const callback of callbacks) {
        try {
          const result = callback();
          if (result && typeof (result as PromiseLike<unknown>).then === 'function')
            void Promise.resolve(result).catch(() => {});
        } catch {
          /* A sibling still retires. */
        }
      }
    } finally {
      this.retiring = false;
    }
  }
  /** Subscribe to invalidation; reentrant subscribers observe the already-cleared current state. */
  subscribe(cleanup: Cleanup): () => void {
    this.subscribers.add(cleanup);
    return () => {
      this.subscribers.delete(cleanup);
    };
  }
  /** Attach a port/timer/abort cleanup only to the actual current observation. */
  own(observation: FrameObservation, cleanup: Cleanup): () => void {
    if (this.retiring || this.current !== observation)
      throw new Error('Frame observation retired.');
    const resources = this.resources.get(observation) ?? new Set<Cleanup>();
    resources.add(cleanup);
    this.resources.set(observation, resources);
    return () => {
      resources.delete(cleanup);
    };
  }
  /** Bind server birth only after host load, separately from generic frame availability. */
  bindDoc(observation: FrameObservation, incarnation: unknown, scope: string): FrameDocBinding {
    return this.#bindDoc(observation, incarnation, scope);
  }
  #bindDoc(observation: FrameObservation, incarnation: unknown, scope: string): FrameDocBinding {
    const originalDoc = this.doc;
    const originalToken = this.token;
    const parsed = parseCanvasDocWire(CanvasDocIncarnationSchema, incarnation);
    if (!parsed) {
      this.disableDoc();
      throw new Error('Established server Doc birth required.');
    }
    const birth = parsed;
    const origin = observation.exactOrigin;
    const validOrigin =
      observation.eligibility === 'served-document'
        ? origin === 'null'
        : observation.eligibility === 'preview-listener' &&
          origin !== null &&
          new URL(origin).origin === origin;
    if (
      !observation.loaded ||
      !observation.frame ||
      typeof observation.frame.postMessage !== 'function' ||
      !observation.resolvedSource ||
      !validOrigin ||
      observation.documentId !== birth.documentId ||
      !scope ||
      scope.length > 200
    )
      throw new Error('Loaded eligible frame and established Doc birth required.');
    // Reading Window.postMessage can reenter host navigation. This fixed private
    // check follows every observable admission read, before reuse or assignment.
    if (
      this.retiring ||
      this.retiringDoc ||
      this.current !== observation ||
      this.doc !== originalDoc ||
      this.token !== originalToken
    )
      throw new Error('Frame observation retired during Doc admission.');
    if (this.doc) {
      if (this.doc.observation !== observation)
        throw new Error('Doc binding belongs to another host load.');
      if (sameCanvasDocIncarnation(this.doc.incarnation, birth) && this.doc.scope === scope)
        return this.doc;
      this.retire();
      throw new Error('Doc birth changed; a fresh host load is required.');
    }
    const binding = Object.freeze({ observation, incarnation: Object.freeze(birth), scope });
    try {
      this.doc = binding;
      this.bindings.add(binding);
      return binding;
    } catch (cause) {
      if (this.doc === binding) this.#disableDoc();
      throw cause;
    }
  }
  /** Genuine claim acquisition: no observable work between successful bind and claim custody. */
  acquireDoc(observation: FrameObservation, incarnation: unknown, scope: string) {
    const binding = this.#bindDoc(observation, incarnation, scope);
    const claim = Object.freeze({});
    this.docClaims.set(binding, claim);
    let released = false;
    return Object.freeze({
      binding,
      release: () => {
        if (released) return;
        released = true;
        if (this.docClaims.get(binding) !== claim) return;
        this.docClaims.delete(binding);
        if (this.doc === binding && this.bindings.has(binding)) this.#disableDoc();
      },
    });
  }
  /** Retire only Doc availability when the server DTO is absent; sibling protocols survive. */
  disableDoc(): void {
    this.#disableDoc();
  }
  /** Close only the captured binding, without callbacks between identity and retirement. */
  retireDoc(binding: FrameDocBinding): void {
    if (this.doc === binding && this.bindings.has(binding)) this.#disableDoc();
  }
  #disableDoc(): void {
    if (this.retiringDoc) return;
    const old = this.doc;
    this.doc = null;
    this.retiringDoc = true;
    const callbacks = [...(old ? (this.docResources.get(old) ?? []) : [])];
    if (old) this.docResources.delete(old);
    try {
      for (const callback of callbacks) {
        try {
          const result = callback();
          if (result && typeof (result as PromiseLike<unknown>).then === 'function')
            void Promise.resolve(result).catch(() => {});
        } catch {
          /* Drain siblings. */
        }
      }
    } finally {
      this.retiringDoc = false;
    }
  }
  /** Attach a Doc-only queue/port resource to this exact issued binding. */
  ownDoc(binding: FrameDocBinding, cleanup: Cleanup): () => void {
    if (!this.isCurrent(binding)) throw new Error('Doc binding retired.');
    const resources = this.docResources.get(binding) ?? new Set<Cleanup>();
    resources.add(cleanup);
    this.docResources.set(binding, resources);
    return () => {
      resources.delete(cleanup);
    };
  }
  /** Prove this controller issued the binding and still owns the same loaded observation. */
  isCurrent(binding: FrameDocBinding): boolean {
    return (
      !this.retiring &&
      !this.retiringDoc &&
      this.doc === binding &&
      this.bindings.has(binding) &&
      this.current === binding.observation
    );
  }
}
