import {
  BrowserInputStepSchema,
  type BrowserControl,
  type BrowserViewer,
  type BrowserFramePointerEnvelope,
  type BrowserRenderReceipt,
  type BrowserInputStep,
} from '@dorkos/shared/browser-schemas';

/** Parsed current visual admission supplied by the owning input adapter; never server permission. */
export interface CanvasGestureContext {
  controller: BrowserControl;
  viewer: BrowserViewer;
  metadata: BrowserFramePointerEnvelope;
  receipt: BrowserRenderReceipt;
}
interface GestureOptions {
  readonly context: () => CanvasGestureContext;
  readonly closed: () => boolean;
  readonly stale: () => Error;
  readonly issue: (
    context: CanvasGestureContext,
    steps: BrowserInputStep[],
    consume: () => void
  ) => void;
  readonly cleanupFailure: (cause: unknown) => void;
}

/** Local collection only: native down/up remain balanced in one release-submitted command. */
export class CanvasGestureCollection {
  private capturePointer?: (id: number) => void;
  private releasePointer?: (id: number) => void;
  private drag?: {
    id: number;
    button: 'left' | 'middle' | 'right';
    scope: string;
    modifiers: string[];
    origin: { x: number; y: number; clientX: number; clientY: number };
    points: Array<{ x: number; y: number }>;
    moved: boolean;
  };
  private stationaryClick?: { scope: string; clientX: number; clientY: number };
  private cancelledDrag?: number;
  private suppressedClick?: { clientX: number; clientY: number };
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: GestureOptions
  ) {
    if (
      typeof canvas.setPointerCapture === 'function' &&
      typeof canvas.releasePointerCapture === 'function'
    ) {
      this.capturePointer = canvas.setPointerCapture.bind(canvas);
      this.releasePointer = canvas.releasePointerCapture.bind(canvas);
    }
  }
  /** Whether an unsubmitted original pointer gesture is being collected. */
  collecting(): boolean {
    return this.drag !== undefined;
  }
  /** Cancel only the matching original pointer capture lifetime. */
  cancelPointer(id: number): void {
    if (this.drag?.id === id) this.cancel();
  }
  /** Clear local trailing-event suppression when the owning input adapter fences. */
  clearCompatibility(): void {
    this.suppressedClick = undefined;
    this.stationaryClick = undefined;
  }
  /** Snapshot the original parsed owner and geometry scope without frame-sequence authority. */
  scope(context: CanvasGestureContext): string {
    return this.dragScope(context);
  }
  private modifiers(event: MouseEvent): string[] {
    return [
      event.shiftKey && 'Shift',
      event.ctrlKey && 'Control',
      event.altKey && 'Alt',
      event.metaKey && 'Meta',
    ].filter((key): key is string => Boolean(key));
  }
  private dragScope(context: CanvasGestureContext): string {
    const rect = this.canvas.getBoundingClientRect();
    if (
      ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      throw this.options.stale();
    return JSON.stringify([
      context.controller,
      context.viewer,
      context.metadata.geometry,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
    ]);
  }
  private dragPoint(event: MouseEvent, context: CanvasGestureContext): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect(),
      { width, height } = context.metadata.geometry.cssViewport;
    const x = ((event.clientX - rect.left) / rect.width) * width,
      y = ((event.clientY - rect.top) / rect.height) * height;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height)
      throw this.options.stale();
    return { x, y };
  }
  /** Fence local collection before releasing the captured original pointer receiver. */
  cancel(): void {
    const original = this.drag;
    this.drag = undefined; // Fence before release can synchronously emit lostpointercapture.
    if (!original) return;
    this.cancelledDrag = original.id;
    try {
      this.releasePointer?.(original.id);
    } catch (cause) {
      this.options.cleanupFailure(cause);
    }
  }
  /** Collect an admitted mouse gesture without entering native input. */
  begin(event: PointerEvent): void {
    if (
      this.options.closed() ||
      this.drag ||
      event.target !== this.canvas ||
      event.pointerType !== 'mouse' ||
      !event.isPrimary ||
      !this.capturePointer
    )
      return;
    const button = (['left', 'middle', 'right'] as const)[event.button];
    if (!button) return;
    try {
      const before = this.options.context(),
        scope = this.dragScope(before),
        point = this.dragPoint(event, before);
      const bank = {
        id: event.pointerId,
        button,
        scope,
        modifiers: this.modifiers(event),
        origin: { ...point, clientX: event.clientX, clientY: event.clientY },
        points: [],
        moved: false,
      };
      this.suppressedClick = undefined;
      this.stationaryClick = undefined;
      this.cancelledDrag = undefined;
      this.drag = bank;
      this.canvas.focus({ preventScroll: true });
      if (
        this.options.closed() ||
        this.drag !== bank ||
        this.dragScope(this.options.context()) !== scope
      ) {
        this.cancel();
        return;
      }
      this.capturePointer(event.pointerId);
      if (
        this.options.closed() ||
        this.drag !== bank ||
        this.dragScope(this.options.context()) !== scope
      )
        this.cancel();
    } catch {
      this.cancel();
    }
  }
  /** Retain a bounded path only while its original scope and button remain current. */
  move(event: PointerEvent): void {
    const bank = this.drag;
    if (!bank || event.pointerId !== bank.id) return;
    try {
      const current = this.options.context();
      if (
        this.dragScope(current) !== bank.scope ||
        JSON.stringify(this.modifiers(event)) !== JSON.stringify(bank.modifiers) ||
        !(event.buttons & { left: 1, right: 2, middle: 4 }[bank.button])
      ) {
        this.cancel();
        return;
      }
      const point = this.dragPoint(event, current);
      bank.moved ||=
        Math.hypot(event.clientX - bank.origin.clientX, event.clientY - bank.origin.clientY) >= 3;
      // Reserve start/down/up and every balanced modifier. Coalesce intermediate points; retain the final point.
      const limit = 13 - 2 * bank.modifiers.length;
      if (bank.moved) this.suppressedClick = { clientX: event.clientX, clientY: event.clientY };
      bank.points.push(point);
      if (bank.points.length > limit) bank.points.shift();
      event.preventDefault();
    } catch {
      this.cancel();
    }
  }
  /** Submit one balanced bounded command against the latest valid drawn receipt. */
  end(event: PointerEvent): void {
    const bank = this.drag;
    if (!bank) {
      if (event.pointerId === this.cancelledDrag) {
        this.suppressedClick = { clientX: event.clientX, clientY: event.clientY };
        this.cancelledDrag = undefined;
        event.preventDefault();
      }
      return;
    }
    if (event.pointerId !== bank.id) return;
    // Fence the browser's trailing click even if ownership/geometry is lost at this final event.
    bank.moved ||=
      Math.hypot(event.clientX - bank.origin.clientX, event.clientY - bank.origin.clientY) >= 3;
    this.suppressedClick = { clientX: event.clientX, clientY: event.clientY };
    try {
      const current = this.options.context();
      if (
        this.dragScope(current) !== bank.scope ||
        event.button !== ['left', 'middle', 'right'].indexOf(bank.button) ||
        JSON.stringify(this.modifiers(event)) !== JSON.stringify(bank.modifiers)
      ) {
        this.cancel();
        return;
      }
      const point = this.dragPoint(event, current);
      bank.moved ||=
        Math.hypot(event.clientX - bank.origin.clientX, event.clientY - bank.origin.clientY) >= 3;
      if (!bank.moved) {
        this.cancel();
        // Only a genuinely unchanged stationary gesture may emit its ordinary click. The
        // captured release receiver can reenter ownership loss; retain suppression if it does.
        if (!this.options.closed() && this.dragScope(this.options.context()) === bank.scope) {
          this.stationaryClick = {
            scope: bank.scope,
            clientX: event.clientX,
            clientY: event.clientY,
          };
          this.suppressedClick = undefined;
        }
        return;
      }
      bank.points.push(point);
      const limit = 13 - 2 * bank.modifiers.length;
      if (bank.points.length > limit) bank.points.shift();
      this.suppressedClick = { clientX: event.clientX, clientY: event.clientY };
      const steps: BrowserInputStep[] = [
        ...bank.modifiers.map((key) => BrowserInputStepSchema.parse({ kind: 'keyDown', key })),
        { kind: 'mouseMove', x: bank.origin.x, y: bank.origin.y },
        { kind: 'mouseDown', button: bank.button },
        ...bank.points.map(({ x, y }): BrowserInputStep => ({ kind: 'mouseMove', x, y })),
        { kind: 'mouseUp', button: bank.button },
        ...[...bank.modifiers]
          .reverse()
          .map((key) => BrowserInputStepSchema.parse({ kind: 'keyUp', key })),
      ];
      this.cancel();
      // Command admission happens here against the latest genuine drawn receipt. Queued coordinate
      // commands still retain that exact receipt and refuse a later frame before actual submission.
      this.options.issue(current, steps, () => {
        if (this.dragScope(this.options.context()) !== bank.scope) throw this.options.stale();
        event.preventDefault();
      });
    } catch {
      this.cancel();
    }
  }
  /** false consumes a compatibility event; undefined admits an ordinary current-context event. */
  clickScope(event: MouseEvent, kind: 'click' | 'mouseMove' | 'wheel'): string | false | undefined {
    const stationary = this.stationaryClick;
    let clickScope: string | undefined;
    // Compatibility click/auxclick have a positive count; contextmenu normally has zero.
    // Zero-detail programmatic click retains its existing current-context semantics.
    if (
      kind === 'click' &&
      stationary &&
      (event.detail > 0 || event.type === 'contextmenu') &&
      event.clientX === stationary.clientX &&
      event.clientY === stationary.clientY
    ) {
      this.stationaryClick = undefined;
      this.suppressedClick = { clientX: event.clientX, clientY: event.clientY };
      clickScope = stationary.scope;
      try {
        if (this.dragScope(this.options.context()) !== stationary.scope) {
          event.preventDefault();
          return false;
        }
      } catch {
        event.preventDefault();
        return false;
      }
    }
    if (event.type === 'contextmenu' && this.drag) {
      const bank = this.drag;
      clickScope = bank.scope;
      event.preventDefault();
      if (bank.moved) return false; // A drag already being collected remains one release-submitted operation.
      this.suppressedClick = { clientX: event.clientX, clientY: event.clientY };
      try {
        if (this.dragScope(this.options.context()) !== bank.scope) {
          this.cancel();
          return false;
        }
        this.cancel();
        if (this.options.closed() || this.dragScope(this.options.context()) !== bank.scope)
          return false;
      } catch {
        this.cancel();
        return false;
      }
      // A real contextmenu may precede pointerup (including Mac Control-click). Route it
      // through the existing canonical secondary click now, then consume the later terminal click.
    } else if (
      clickScope === undefined &&
      kind === 'click' &&
      (event.detail > 0 || event.type === 'contextmenu') &&
      this.suppressedClick &&
      event.clientX === this.suppressedClick.clientX &&
      event.clientY === this.suppressedClick.clientY
    ) {
      event.preventDefault();
      return false; // Browser-generated click/auxclick/contextmenu after a drag must not submit twice.
    }
    return clickScope;
  }
}
