import { CanvasGestureCollection } from './canvas-gesture';
import { CanvasEditableInput } from './canvas-editable-input';
import {
  BrowserControlSchema,
  BrowserViewerSchema,
  BrowserFramePointerEnvelopeSchema,
  BrowserFrameAcknowledgmentSchema,
  BrowserInputRequestSchema,
  BrowserInputStepSchema,
  BrowserActionReceiptSchema,
  type BrowserBinding,
  type BrowserControl,
  type BrowserViewer,
  type BrowserRenderReceipt,
  type BrowserInputStep,
} from '@dorkos/shared/browser-schemas';
import type { BrowserInputTransport } from '@dorkos/shared/transport';
import type { BrowserPixelPresentation } from './pixel-renderer';

/** Exact original visual receipt plus current owner-supplied controller context; metadata is not permission. */
export interface BrowserRenderedInputContext {
  readonly identity: object;
  readonly controller: BrowserControl;
  readonly viewer: BrowserViewer;
  readonly presentation: BrowserPixelPresentation;
  readonly receipt: BrowserRenderReceipt;
}
const same = (a: BrowserBinding, b: BrowserBinding) =>
  (Object.keys(a) as (keyof BrowserBinding)[]).every((key) => a[key] === b[key]);
/** Private local visual/currentness refusal; genuine authority remains in original server input Work. */
export class BrowserCanvasInputRefusal extends Error {
  constructor(readonly reason: 'stale' | 'result' | 'capacity') {
    super(reason);
  }
}

/** One active original with at most sixteen pending atomic commands; no retry.
 * Atomic clicks/key taps and release-submitted drags keep their downs/ups in one command.
 * Drag collection has no native effect; it does not provide live remote dragging.
 * No local event sets the canonical pointer or caret; only original screenshot metadata does. */
export class BrowserCanvasInput {
  private readonly ime: HTMLTextAreaElement;
  private composing?: { controllerId: string; viewerId: string; binding: BrowserBinding };
  private readonly editableReceiver: CanvasEditableInput<ReturnType<BrowserCanvasInput['context']>>;
  private readonly submit: BrowserInputTransport['inputBrowser'];
  private readonly controller = new AbortController();
  private readonly lossSignals: readonly AbortSignal[];
  private readonly removals: Array<() => void> = [];
  private readonly uuid: () => string;
  private active?: Promise<void>;
  private gesture?: CanvasGestureCollection;
  private readonly pending: Array<{
    command: ReturnType<typeof BrowserInputRequestSchema.parse>;
    controllerId: string;
    visual: string | undefined;
  }> = [];
  private closing?: Promise<void>;
  private closed = false;
  private replacing = false;
  private readonly replacementReason = Object.freeze(
    new Error('original input disposal requested')
  );
  private resourceCleanup?: Readonly<{ reason: unknown }>;
  private resourceSettled = false;
  private failed = false;
  private first: unknown;
  private reported = false;
  constructor(
    private readonly canvas: HTMLCanvasElement,
    port: BrowserInputTransport,
    private readonly identity: object,
    private readonly read: () => BrowserRenderedInputContext | undefined,
    signals: readonly AbortSignal[],
    private readonly onFailure: (cause: unknown) => void = () => undefined
  ) {
    this.ime = canvas.ownerDocument.createElement('textarea');
    this.ime.setAttribute('aria-label', 'Browser typing');
    this.ime.setAttribute('autocomplete', 'off');
    this.ime.setAttribute('autocapitalize', 'off');
    this.ime.spellcheck = false;
    this.ime.tabIndex = -1;
    // Frames expose no editable caret rectangle yet. Keep the native candidate anchor at the
    // visible canvas origin; this receiver does not claim remote-caret candidate placement.
    this.ime.style.cssText =
      'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0;padding:0;border:0';
    this.editableReceiver = new CanvasEditableInput(
      this.ime,
      Object.freeze({
        context: () => this.context(),
        closed: () => this.closed,
        composing: () => !!this.composing,
        updateComposition: () => this.updateComposition(),
        cancelGesture: () => this.gesture?.cancel(),
        stale: () => new BrowserCanvasInputRefusal('stale'),
        issue: (
          context: ReturnType<BrowserCanvasInput['context']>,
          steps: BrowserInputStep[],
          consume: () => void
        ) => this.issue(context, steps, consume),
      })
    );
    this.lossSignals = Object.freeze([...signals]);
    this.submit = port.inputBrowser.bind(port);
    const random = crypto.getRandomValues.bind(crypto);
    this.uuid = () =>
      Array.from(random(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join(
        ''
      );
    const add = canvas.addEventListener.bind(canvas),
      remove = canvas.removeEventListener.bind(canvas);
    const register = (type: string, listener: EventListener, options?: AddEventListenerOptions) => {
      // Retain each exact original remover before registration can run a callback/refuse.
      this.removals.push(() => remove(type, listener, options));
      add(type, listener, options);
    };
    try {
      const ime = this.ime,
        removeIme = ime.remove.bind(ime);
      this.removals.push(removeIme);
      (canvas.parentElement ?? canvas.ownerDocument.body).appendChild(ime);
      const imeAdd = ime.addEventListener.bind(ime),
        imeRemove = ime.removeEventListener.bind(ime);
      const registerIme = (type: string, listener: EventListener) => {
        this.removals.push(() => imeRemove(type, listener));
        imeAdd(type, listener);
      };
      registerIme('focus', () => this.editableReceiver.capture());
      registerIme('beforeinput', (event) => this.editableReceiver.beforeEdit(event as InputEvent));
      registerIme('paste', (event) => this.editableReceiver.paste(event as ClipboardEvent));
      registerIme('keydown', (event) => this.keyboard(event as KeyboardEvent));
      registerIme('compositionstart', () => this.beginComposition());
      registerIme('input', (event) => {
        this.editableReceiver.inputEvent(event as InputEvent);
      });
      registerIme('compositionend', (event) =>
        this.endComposition((event as CompositionEvent).data)
      );
      registerIme('blur', () => {
        if (this.closed) return;
        try {
          this.cancelComposition();
          this.editableReceiver.close();
        } catch (cause) {
          this.failure(cause);
          this.fence();
          this.report();
        }
      });
      register('focus', () => {
        if (!this.closed) {
          this.positionIme();
          ime.focus({ preventScroll: true });
        }
      });
      this.gesture = new CanvasGestureCollection(canvas, {
        context: () => this.context(),
        closed: () => this.closed,
        stale: () => new BrowserCanvasInputRefusal('stale'),
        issue: (
          context: ReturnType<BrowserCanvasInput['context']>,
          steps: BrowserInputStep[],
          consume: () => void
        ) => this.issue(context, steps, consume),
        cleanupFailure: (cause) => {
          this.resourceCleanup ??= Object.freeze({ reason: cause });
          this.failure(cause);
          this.fence();
          this.report();
        },
      });
      register('pointerdown', (event) => this.gesture?.begin(event as PointerEvent));
      register('pointerup', (event) => this.gesture?.end(event as PointerEvent));
      register('pointercancel', (event) => {
        this.gesture?.cancelPointer((event as PointerEvent).pointerId);
      });
      register('lostpointercapture', (event) => {
        this.gesture?.cancelPointer((event as PointerEvent).pointerId);
      });
      register('blur', (event) => {
        if ((event as FocusEvent).relatedTarget === this.ime) return;
        this.gesture?.cancel();
        this.cancelComposition();
      });
      register('click', (event) => this.pointer(event as MouseEvent, 'click'));
      register('auxclick', (event) => this.pointer(event as MouseEvent, 'click'));
      register('contextmenu', (event) => {
        event.preventDefault(); // The canvas represents the remote page, never the host browser menu.
        this.pointer(event as MouseEvent, 'click');
      });
      register('pointermove', (event) => {
        if ((event as PointerEvent).pointerType !== 'mouse') return;
        if (this.gesture?.collecting()) this.gesture.move(event as PointerEvent);
        else this.pointer(event as PointerEvent, 'mouseMove');
      });
      register('wheel', (event) => this.pointer(event as WheelEvent, 'wheel'), { passive: false });
      register('keydown', (event) => this.keyboard(event as KeyboardEvent));
      for (const signal of signals) {
        if (this.closed) break;
        const off = signal.removeEventListener.bind(signal),
          on = signal.addEventListener.bind(signal);
        const lost = () => {
          this.failure(signal.reason);
          this.fence();
          this.report();
        };
        this.removals.push(() => off('abort', lost));
        on('abort', lost, { once: true });
        if (signal.aborted) lost();
      }
      if (this.failed) throw this.first;
    } catch (error) {
      this.failure(error);
      this.fence();
      throw this.first;
    }
  }
  private failure(cause: unknown): void {
    if (!this.failed) {
      this.failed = true;
      this.first = cause;
    }
  }
  private report(): void {
    if (this.reported) return;
    this.reported = true;
    try {
      this.onFailure(this.first);
    } catch (cause) {
      this.failure(cause);
    }
  }
  private context() {
    if (this.closed)
      throw this.replacing ? this.replacementReason : new BrowserCanvasInputRefusal('stale');
    const original = this.read();
    if (!original || original.identity !== this.identity)
      throw new BrowserCanvasInputRefusal('stale');
    const controller = BrowserControlSchema.parse(original.controller);
    const viewer = BrowserViewerSchema.parse(original.viewer);
    const metadata = BrowserFramePointerEnvelopeSchema.parse({
      frame: original.presentation.frame,
      geometry: original.presentation.geometry,
      pointer: original.presentation.pointer,
    });
    const { receipt } = BrowserFrameAcknowledgmentSchema.parse({
      frame: metadata.frame,
      receipt: original.receipt,
    });
    if (
      controller.status !== 'ready' ||
      !controller.controllerId ||
      Date.now() >= Date.parse(viewer.expiresAt) ||
      viewer.viewerId !== metadata.frame.viewerId ||
      !same(viewer.binding, metadata.frame.binding) ||
      !same(controller.binding, metadata.frame.binding) ||
      this.closed
    )
      throw new BrowserCanvasInputRefusal('stale');
    return { controller, viewer, metadata, receipt };
  }
  private visual(context: ReturnType<BrowserCanvasInput['context']>): string {
    // Canonical parsed clones retain the exact original coordinate admission, independent of mutation.
    return JSON.stringify({
      viewer: context.viewer,
      metadata: context.metadata,
      receipt: context.receipt,
    });
  }
  private async entered(
    command: ReturnType<typeof BrowserInputRequestSchema.parse>,
    controllerId: string,
    visual?: string
  ): Promise<void> {
    try {
      const before = this.context();
      if (
        before.controller.controllerId !== controllerId ||
        !same(before.controller.binding, command.binding) ||
        (visual !== undefined && this.visual(before) !== visual)
      )
        throw new BrowserCanvasInputRefusal('stale');
      let raw: unknown;
      try {
        raw = await this.submit(command, controllerId, this.controller.signal);
      } catch (reason) {
        this.resourceCleanup ??= Object.freeze({ reason });
        throw reason;
      }
      let receipt: ReturnType<typeof BrowserActionReceiptSchema.parse>;
      try {
        receipt = BrowserActionReceiptSchema.parse(raw);
        if (receipt.requestId !== command.requestId || !same(receipt.binding, command.binding))
          throw new BrowserCanvasInputRefusal('result');
        if (receipt.outcome !== 'completed') throw receipt;
      } catch (reason) {
        this.resourceCleanup ??= Object.freeze({ reason });
        throw reason;
      }
      // Actual original response/body completed before this local context observation.
      // A replaced visual/controller does not turn that returned request into retained work.
      this.context();
    } catch (error) {
      if (
        this.replacing &&
        !this.failed &&
        this.lossSignals.every((signal) => !signal.aborted) &&
        error === this.replacementReason
      )
        return;
      this.failure(error);
      this.fence();
      this.report();
      throw this.first;
    }
  }
  private issue(
    before: ReturnType<BrowserCanvasInput['context']>,
    steps: BrowserInputStep[],
    consume: () => void
  ): void {
    if (this.closed) return;
    const command = BrowserInputRequestSchema.parse({
      kind: 'input',
      requestId: this.uuid(),
      binding: before.controller.binding,
      steps,
    });
    consume();
    if (this.closed) return;
    // DOM bounds/focus/default prevention/ID creation are fallible callbacks; recheck exact ownership last.
    const final = this.context();
    if (
      final.controller.controllerId !== before.controller.controllerId ||
      final.viewer.viewerId !== before.viewer.viewerId ||
      final.metadata.frame.frameId !== before.metadata.frame.frameId ||
      final.metadata.frame.sequence !== before.metadata.frame.sequence ||
      !same(final.controller.binding, before.controller.binding)
    )
      throw new BrowserCanvasInputRefusal('stale');
    if (this.closed) return;
    const coordinate = steps.some(
      (step) => step.kind === 'click' || step.kind === 'mouseMove' || step.kind === 'wheel'
    );
    const record = {
      command,
      controllerId: final.controller.controllerId!,
      visual: coordinate ? this.visual(before) : undefined,
    };
    if (coordinate && this.visual(final) !== record.visual)
      throw new BrowserCanvasInputRefusal('stale');
    if (this.active) {
      if (this.pending.length >= 16) {
        this.failure(new BrowserCanvasInputRefusal('capacity'));
        this.fence();
        this.report();
      } else this.pending.push(record);
      return;
    }
    const original = Promise.resolve().then(async () => {
      let next: typeof record | undefined = record;
      while (next && !this.closed) {
        await this.entered(next.command, next.controllerId, next.visual);
        next = this.pending.shift();
      }
    });
    this.active = original;
    void original.then(
      () => {
        if (this.active === original) this.active = undefined;
      },
      () => undefined
    );
  }
  private pointer(event: MouseEvent, kind: 'click' | 'mouseMove' | 'wheel'): void {
    const clickScope = this.gesture?.clickScope(event, kind);
    if (clickScope === false) return;
    if (
      this.closed ||
      this.gesture?.collecting() ||
      event.target !== this.canvas ||
      (this.active && kind !== 'click')
    )
      return;
    try {
      // Modifier pointer gestures cannot be represented as an unmodified click/scroll.
      // Actual context-menu gestures (including Mac Control-click) are canonical secondary clicks.
      if (
        event.type !== 'contextmenu' &&
        (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
      )
        return;
      const context = this.context(),
        rect = this.canvas.getBoundingClientRect();
      if (clickScope !== undefined && this.gesture?.scope(context) !== clickScope) return;
      const { width, height } = context.metadata.geometry.cssViewport;
      if (
        !Number.isFinite(rect.width) ||
        !Number.isFinite(rect.height) ||
        rect.width <= 0 ||
        rect.height <= 0
      )
        return;
      const x = ((event.clientX - rect.left) / rect.width) * width,
        y = ((event.clientY - rect.top) / rect.height) * height;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height)
        return;
      let steps: BrowserInputStep[];
      if (kind === 'wheel') {
        const wheel = event as WheelEvent;
        // Native wheel deltas are pixels; unsupported line/page modes are not guessed.
        if (wheel.deltaMode !== 0) return;
        steps = [
          { kind: 'mouseMove', x, y },
          BrowserInputStepSchema.parse({
            kind: 'wheel',
            deltaX: wheel.deltaX,
            deltaY: wheel.deltaY,
          }),
        ];
      } else if (kind === 'click') {
        const button =
          event.type === 'contextmenu'
            ? 'right'
            : (['left', 'middle', 'right'] as const)[event.button];
        if (
          !button ||
          (event.type === 'auxclick' && button === 'right' && clickScope === undefined)
        )
          return;
        steps = [{ kind, x, y, button }];
      } else steps = [{ kind, x, y }];
      this.issue(context, steps, () => {
        event.preventDefault();
        if (kind === 'click') this.canvas.focus({ preventScroll: true });
        if (clickScope !== undefined && this.gesture?.scope(this.context()) !== clickScope)
          throw new BrowserCanvasInputRefusal('stale');
      });
    } catch {
      /* Unavailable/malformed/stale visual context never enters an input producer. */
    }
  }
  private positionIme(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (Number.isFinite(rect.left) && Number.isFinite(rect.top)) {
      const viewport = this.canvas.ownerDocument.defaultView;
      const left = Math.min(Math.max(0, rect.left), Math.max(0, (viewport?.innerWidth ?? 1) - 1));
      const top = Math.min(Math.max(0, rect.top), Math.max(0, (viewport?.innerHeight ?? 1) - 1));
      this.ime.style.left = `${left}px`;
      this.ime.style.top = `${top}px`;
    }
  }
  private beginComposition(): void {
    if (this.closed || this.canvas.ownerDocument.activeElement !== this.ime) return;
    try {
      this.positionIme();
      this.gesture?.cancel();
      const context = this.editableReceiver.context();
      this.composing = {
        controllerId: context.controller.controllerId!,
        viewerId: context.viewer.viewerId,
        binding: context.controller.binding,
      };
    } catch {
      this.composing = undefined;
      this.ime.value = '';
    }
  }
  private compositionContext() {
    const original = this.composing;
    const context = this.context();
    if (
      !original ||
      context.controller.controllerId !== original.controllerId ||
      context.viewer.viewerId !== original.viewerId ||
      !same(context.controller.binding, original.binding)
    )
      throw new BrowserCanvasInputRefusal('stale');
    return context;
  }
  private updateComposition(): void {
    if (!this.composing || this.closed) return;
    try {
      const context = this.compositionContext();
      const step = BrowserInputStepSchema.parse({
        kind: 'composition',
        text: this.ime.value,
        selectionStart: this.ime.selectionStart,
        selectionEnd: this.ime.selectionEnd,
      });
      this.issue(context, [step], () => {});
    } catch {
      this.cancelComposition(); // Retain original scope until an earlier native preedit can be canceled.
      this.composing = undefined;
      this.ime.value = '';
    }
  }
  private endComposition(text: string): void {
    if (!this.composing || this.closed) return;
    try {
      const context = this.compositionContext();
      const step = BrowserInputStepSchema.parse(
        text.length > 0
          ? { kind: 'compositionCommit', text }
          : { kind: 'composition', text: '', selectionStart: 0, selectionEnd: 0 }
      );
      this.issue(context, [step], () => {
        this.composing = undefined;
        this.ime.value = '';
        this.editableReceiver.committed(text, context);
      });
    } catch {
      if (text.length > 0) this.endComposition('');
      this.composing = undefined;
      this.ime.value = '';
    }
  }
  private cancelComposition(): void {
    this.endComposition('');
  }
  private keyboard(event: KeyboardEvent): void {
    if (
      this.closed ||
      (event.target !== this.canvas && event.target !== this.ime) ||
      (this.canvas.ownerDocument.activeElement !== this.canvas &&
        this.canvas.ownerDocument.activeElement !== this.ime) ||
      !!this.composing ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.repeat
    )
      return;
    try {
      this.gesture?.cancel(); // A keyboard operation replaces an unsubmitted local pointer gesture.
      // Native paste stays local until its actual ClipboardEvent carries the user-selected data.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
      const context = event.target === this.ime ? this.editableReceiver.context() : this.context();
      let steps: BrowserInputStep[];
      if (
        event.key !== ' ' &&
        Array.from(event.key).length === 1 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        steps = [BrowserInputStepSchema.parse({ kind: 'text', text: event.key })];
      } else {
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
        const key = event.key === ' ' ? 'Space' : event.key;
        const down = BrowserInputStepSchema.parse({ kind: 'keyDown', key });
        const modifiers = (
          [
            ['Shift', event.shiftKey],
            ['Control', event.ctrlKey],
            ['Alt', event.altKey],
            ['Meta', event.metaKey],
          ] as const
        )
          .filter((entry) => entry[1])
          .map((entry) => entry[0]);
        steps = [
          ...modifiers.map((key) => ({ kind: 'keyDown' as const, key })),
          down,
          BrowserInputStepSchema.parse({ kind: 'keyUp', key }),
          ...[...modifiers].reverse().map((key) => ({ kind: 'keyUp' as const, key })),
        ];
      }
      this.issue(context, steps, () => event.preventDefault());
    } catch {
      /* Unsupported keys or absent exact controller/render context are not approximated. */
    }
  }
  private fence(): void {
    this.closed = true;
    this.composing = undefined;
    this.pending.length = 0;
    this.gesture?.clearCompatibility();
    for (const close of [
      () => this.editableReceiver.close(),
      () => this.gesture?.cancel(),
      () =>
        this.controller.abort(
          this.failed
            ? this.first
            : this.replacing
              ? this.replacementReason
              : new BrowserCanvasInputRefusal('stale')
        ),
      ...this.removals.splice(0),
    ]) {
      try {
        close();
      } catch (error) {
        this.resourceCleanup ??= Object.freeze({ reason: error });
        this.failure(error);
      }
    }
  }
  /** Stop the current local input before navigation, joining the exact original POST and its
   * body cancellation. Only this exact locally issued stop is expected; original failures remain. */
  disposeForNavigation(): Promise<void> {
    if (!this.closing) this.replacing = true;
    return this.close();
  }
  /** Independent actual request/listener cleanup, with the original primary retained separately.
   * A rejected/uncertain submitted body remains unknown and cannot authorize a successor. */
  async settleForSuccessor(): Promise<
    Readonly<{
      settled: boolean;
      cleanup: Readonly<{ failed: false } | { failed: true; first: unknown }>;
      primary: Readonly<{ failed: false } | { failed: true; first: unknown }>;
    }>
  > {
    try {
      await this.close();
    } catch {
      /* Original first failure remains retained in this bank. */
    }
    return Object.freeze({
      settled: this.resourceSettled,
      cleanup: this.resourceCleanup
        ? Object.freeze({ failed: true as const, first: this.resourceCleanup.reason })
        : Object.freeze({ failed: false as const }),
      primary: this.failed
        ? Object.freeze({ failed: true as const, first: this.first })
        : Object.freeze({ failed: false as const }),
    });
  }
  /** Fence listeners/abort now, then retain/join the exact original submitted request through settlement. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (cause: unknown) => void;
    this.closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.fence();
    void Promise.allSettled(this.active ? [this.active] : []).then((results) => {
      if (this.replacing) {
        const lost = this.lossSignals.find((signal) => signal.aborted);
        if (lost) this.failure(lost.reason);
      }
      for (const result of results) if (result.status === 'rejected') this.failure(result.reason);
      this.resourceSettled = true;
      if (this.failed) reject(this.first);
      else resolve();
    });
    void this.closing.catch(() => undefined);
    return this.closing;
  }
}
