import { useLayoutEffect, useRef, useState } from 'react';
import {
  BrowserViewerPump,
  BrowserCanvasInput,
  type BrowserViewerContext,
  type BrowserViewerDeliveryPort,
  type BrowserPixelPresentation,
  type BrowserViewer,
} from '@/layers/entities/browser';
import type { BrowserControl, BrowserRenderReceipt } from '@dorkos/shared/browser-schemas';
import type { BrowserInputTransport } from '@dorkos/shared/transport';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { ManagedBrowserPointer } from './ManagedBrowserPointer';

/** Existing owner/controller context. This does not request takeover or supply server permission. */
export interface ManagedBrowserViewerInput {
  readonly delivery: BrowserInputTransport;
  readonly identity: object;
  readonly readController: () => BrowserControl | undefined;
  readonly lossSignal: AbortSignal;
}
/** Local retained disposal only; callers still need genuine server navigation authority. */
export interface ManagedBrowserViewerLifetime {
  disposeForNavigation(): Promise<void>;
  disposeForSuccessor?(): Promise<Readonly<{ priorFailure?: Readonly<{ value: unknown }> }>>;
}
// Each original setup owns this private record before its asynchronous constructor entry.
type PumpSetup = { settle?: BrowserViewerPump['settleForSuccessor'] };
type LifetimeBank = {
  closed: boolean;
  copySelection?: BrowserCanvasInput['copySelection'];
  drawAfterOriginalInput?: BrowserCanvasInput['drawAfterOriginalInput'];
  closes: Array<() => Promise<void>>;
  setups: Promise<void>[];
  pumpSetups: Map<Promise<void>, PumpSetup>;
  pumpReports: Map<() => Promise<void>, BrowserViewerPump['settleForSuccessor']>;
  successor?: Promise<Readonly<{ priorFailure?: Readonly<{ value: unknown }> }>>;
  original?: Promise<void>;
  handle: ManagedBrowserViewerLifetime;
};
/** Private display inputs supplied by an existing authorized owner; no readiness or permission. */
export interface ManagedBrowserViewerProps {
  /** Optional semantic capability; absence enters no producer. */
  delivery?: BrowserViewerDeliveryPort;
  /** Stable local lifetime descriptor. Replace it to dispose the current view. */
  context?: BrowserViewerContext;
  /** Actual owner loss signal; abort immediately fences the original canvas/pump. */
  lossSignal: AbortSignal;
  /** Accessible description of the displayed remote page. */
  label?: string;
  className?: string;
  /** Optional existing controller path; absence keeps this canvas display-only. */
  input?: ManagedBrowserViewerInput;
  /** Capture the original local lifetime before submitting navigation. Undefined revokes it. */
  onLifetime?: (lifetime: ManagedBrowserViewerLifetime | undefined) => void;
}
type Inputs = Pick<ManagedBrowserViewerProps, 'delivery' | 'context' | 'lossSignal'>;
type Visual = {
  inputs: Inputs;
  presentation?: BrowserPixelPresentation;
  viewer?: BrowserViewer;
  stopped: boolean;
  failure?: Readonly<{ value: unknown }>;
};

/** Private reusable canvas display, with original disposal joined before this canvas is reused.
 * Optional input uses only existing owner-supplied control and exact original draw receipt.
 * No mount, takeover, retry, durable pixels/tickets, synthetic cursor or caret is added. */
export function ManagedBrowserViewer({
  delivery,
  context,
  lossSignal,
  label = 'Shared browser',
  className,
  input,
  onLifetime,
}: ManagedBrowserViewerProps) {
  const lifetime = useRef<LifetimeBank | undefined>(undefined);
  const [copyStatus, setCopyStatus] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previousClose = useRef<Promise<void> | undefined>(undefined);
  const [visual, setVisual] = useState<Visual>();
  const [inputFailure, setInputFailure] =
    useState<Readonly<{ value: unknown; input: ManagedBrowserViewerInput; inputs: Inputs }>>();
  const drawn = useRef<
    | {
        inputs: Inputs;
        presentation: BrowserPixelPresentation;
        viewer: BrowserViewer;
        receipt: BrowserRenderReceipt;
      }
    | undefined
  >(undefined);
  const previousInputClose = useRef<Promise<void> | undefined>(undefined);

  useLayoutEffect(() => {
    const bank: LifetimeBank = {
      closed: false,
      closes: [],
      setups: [],
      pumpSetups: new Map(),
      pumpReports: new Map(),
      handle: {
        disposeForSuccessor: () => {
          if (bank.successor) return bank.successor;
          let resolve!: (value: Readonly<{ priorFailure?: Readonly<{ value: unknown }> }>) => void;
          let reject!: (reason: unknown) => void;
          bank.successor = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          });
          // No server permission here. Fence local coordinates and pixels before joining originals.
          bank.closed = true;
          if (lifetime.current === bank) {
            drawn.current = undefined;
            setVisual(undefined);
            setInputFailure(undefined);
          }
          const reports = new Map<
            BrowserViewerPump['settleForSuccessor'],
            Awaited<ReturnType<BrowserViewerPump['settleForSuccessor']>>
          >();
          const originals: Promise<void>[] = [];
          let first: Readonly<{ value: unknown }> | undefined;
          const retain = (value: unknown) => {
            first ??= Object.freeze({ value });
          };
          for (const close of bank.closes) {
            const report = bank.pumpReports.get(close);
            try {
              const original = report
                ? report().then((value) => {
                    reports.set(report, value);
                    if (!value.settled)
                      throw new Error('Original viewer cleanup is still retained');
                    if (value.cleanup.failed) throw value.cleanup.first;
                  })
                : close();
              void original.catch(retain);
              originals.push(original);
            } catch (value) {
              retain(value);
            }
          }
          // Keep the ordinary bank's exact first failure for later teardown; its rejection
          // is diagnostic, never accepted as a replacement grant or cleanup observation.
          void (async () => {
            await Promise.allSettled([...originals, ...bank.setups]);
            for (const [index, result] of (await Promise.allSettled(bank.setups)).entries()) {
              if (result.status !== 'rejected') continue;
              const exactPump = bank.pumpSetups.get(bank.setups[index]!)?.settle;
              const report = exactPump ? reports.get(exactPump) : undefined;
              const known =
                report?.settled &&
                !report.cleanup.failed &&
                report.primary.failed &&
                Object.is(report.primary.first, result.reason);
              if (!known) retain(result.reason);
            }
            if (first) throw first.value;
            const prior = [...reports.values()].find((report) => report.primary.failed)?.primary;
            return Object.freeze(
              prior?.failed ? { priorFailure: Object.freeze({ value: prior.first }) } : {}
            );
          })().then(resolve, reject);
          void bank.successor.catch(() => undefined);
          return bank.successor;
        },
        disposeForNavigation: () => {
          if (bank.original) return bank.original;
          bank.closed = true;
          if (lifetime.current === bank) {
            drawn.current = undefined;
            setVisual(undefined);
            setInputFailure(undefined);
          }
          let resolve!: () => void, reject!: (cause: unknown) => void;
          bank.original = new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
          });
          const originals: Promise<void>[] = [];
          let failed = false,
            first: unknown;
          const observe = (original: Promise<void>) => {
            void original.catch((cause: unknown) => {
              if (!failed) {
                failed = true;
                first = cause;
              }
            });
            return original;
          };
          for (const close of bank.closes) {
            try {
              originals.push(observe(close()));
            } catch (cause) {
              originals.push(observe(Promise.reject(cause)));
            }
          }
          void Promise.allSettled([...originals, ...bank.setups.map(observe)]).then(() => {
            if (failed) reject(first);
            else resolve();
          });
          void bank.original.catch(() => undefined);
          return bank.original;
        },
      },
    };
    lifetime.current = bank;

    return () => {
      bank.closed = true;
      if (lifetime.current === bank) {
        lifetime.current = undefined;
      }
    };
  }, [delivery, context, lossSignal, input]);

  useLayoutEffect(() => {
    onLifetime?.(lifetime.current?.handle);
    return () => onLifetime?.(undefined);
  }, [onLifetime, delivery, context, lossSignal, input]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !delivery || !context) return;
    const inputs = { delivery, context, lossSignal };
    const precedingOriginals = [previousClose.current, previousInputClose.current].filter(
      (original): original is Promise<void> => original !== undefined
    );
    const bank = lifetime.current;
    let active = true;
    let closeOriginal: BrowserViewerPump['close'] | undefined;
    // Await original disposal even when it rejects; it remains the prior lifetime's exact outcome.
    // Superseded waiting setups enter no pump and do not create a chain of substitute completions.
    const originalSetup: PumpSetup = {};
    const setup: Promise<void> = (async () => {
      await Promise.allSettled(precedingOriginals);
      if (!active || bank?.closed) return;
      try {
        const pump = new BrowserViewerPump(
          canvas,
          delivery,
          () => (active ? context : undefined),
          lossSignal,
          (presentation, viewer, receipt) => {
            if (active) {
              drawn.current =
                presentation && viewer && receipt
                  ? { inputs, presentation, viewer, receipt }
                  : undefined;
              setVisual({ inputs, presentation, viewer, stopped: !presentation });
            }
          },
          async (draw, signal) => {
            if (!active || bank?.closed || signal.aborted) throw signal.reason;
            if (bank?.drawAfterOriginalInput) await bank.drawAfterOriginalInput(draw, signal);
            else draw();
          }
        );
        closeOriginal = pump.close.bind(pump);
        const dispose = pump.disposeForNavigation.bind(pump);
        bank?.closes.push(dispose);
        const settle = pump.settleForSuccessor.bind(pump);
        bank?.pumpReports.set(dispose, settle);
        originalSetup.settle = settle;
        await pump.start();
      } catch (value) {
        if (active) setVisual({ inputs, stopped: true, failure: Object.freeze({ value }) });
        throw value;
      }
    })();
    bank?.setups.push(setup);
    bank?.pumpSetups.set(setup, originalSetup);
    void setup.catch(() => undefined);
    return () => {
      // Layout cleanup runs before a successor paints; stale callbacks cannot publish visual state.
      active = false;
      if (drawn.current?.inputs === inputs) drawn.current = undefined;
      if (closeOriginal) {
        const original = closeOriginal();
        previousClose.current = original;
        // React cannot await cleanup. Retain/join this exact original independently of UI lifetime.
        void original.catch(() => undefined);
      }
    };
  }, [delivery, context, lossSignal, input]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !input || !context || !delivery) return;
    const precedingOriginal = previousInputClose.current;
    const readController = input.readController.bind(input);
    const bank = lifetime.current;
    let active = true;
    let closeOriginal: BrowserCanvasInput['close'] | undefined;
    let originalDraw: BrowserCanvasInput['drawAfterOriginalInput'] | undefined;
    let originalCopy: BrowserCanvasInput['copySelection'] | undefined;
    const setup = (async () => {
      await Promise.allSettled(precedingOriginal ? [precedingOriginal] : []);
      if (!active || bank?.closed) return;
      try {
        const adapter = new BrowserCanvasInput(
          canvas,
          input.delivery,
          input.identity,
          () => {
            const frame = drawn.current;
            if (
              !active ||
              bank?.closed ||
              !frame ||
              lossSignal.aborted ||
              frame.inputs.context !== context ||
              frame.inputs.delivery !== delivery ||
              frame.inputs.lossSignal !== lossSignal
            )
              return undefined;
            const controller = readController();
            return controller
              ? {
                  identity: input.identity,
                  controller,
                  viewer: frame.viewer,
                  presentation: frame.presentation,
                  receipt: frame.receipt,
                }
              : undefined;
          },
          [input.lossSignal, lossSignal],
          (value) => {
            if (active)
              setInputFailure(
                Object.freeze({ value, input, inputs: { context, delivery, lossSignal } })
              );
          },
          (message) => {
            if (active && !bank?.closed) setCopyStatus(message);
          }
        );
        originalCopy = adapter.copySelection.bind(adapter);
        if (bank) bank.copySelection = originalCopy;
        originalDraw = adapter.drawAfterOriginalInput.bind(adapter);
        if (bank) bank.drawAfterOriginalInput = originalDraw;
        closeOriginal = adapter.close.bind(adapter);
        const dispose = adapter.disposeForNavigation.bind(adapter);
        bank?.closes.push(dispose);
        bank?.pumpReports.set(dispose, adapter.settleForSuccessor.bind(adapter));
      } catch (value) {
        if (active)
          setInputFailure(
            Object.freeze({ value, input, inputs: { context, delivery, lossSignal } })
          );
        throw value;
      }
    })();
    bank?.setups.push(setup);
    void setup.catch(() => undefined);
    return () => {
      active = false;
      if (bank && bank.copySelection === originalCopy) bank.copySelection = undefined;
      if (bank && bank.drawAfterOriginalInput === originalDraw)
        bank.drawAfterOriginalInput = undefined;
      if (closeOriginal) {
        const original = closeOriginal();
        previousInputClose.current = original;
        void original.catch(() => undefined);
      }
    };
  }, [input, context, delivery, lossSignal]);

  const current =
    visual &&
    visual.inputs.delivery === delivery &&
    visual.inputs.context === context &&
    visual.inputs.lossSignal === lossSignal
      ? visual
      : undefined;
  const presentation = current?.presentation;
  const stopped = !!current?.stopped;
  return (
    <section className={cn('min-w-0', className)} aria-label={label}>
      {!delivery || !context ? (
        <p role="status" className="text-muted-foreground text-sm">
          Browser view is unavailable.
        </p>
      ) : current?.failure ? (
        <p role="alert" className="text-destructive text-sm">
          Browser view stopped. Reopen the view to try again.
        </p>
      ) : !presentation ? (
        <p role="status" className="text-muted-foreground text-sm">
          {stopped ? 'Browser view stopped.' : 'Loading browser view…'}
        </p>
      ) : null}
      {inputFailure &&
        inputFailure.input === input &&
        inputFailure.inputs.context === context &&
        inputFailure.inputs.delivery === delivery &&
        inputFailure.inputs.lossSignal === lossSignal && (
          <p role="alert" className="text-destructive text-sm">
            Browser input stopped. Reopen the view to try again.
          </p>
        )}
      {input && presentation && !stopped && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(event) => lifetime.current?.copySelection?.(event.nativeEvent)}
          >
            Copy selected text
          </Button>
          <span role="status" className="text-muted-foreground text-sm">
            {copyStatus}
          </span>
        </div>
      )}
      <div className="relative w-full">
        <canvas
          ref={canvasRef}
          width={0}
          height={0}
          tabIndex={input ? 0 : undefined}
          role="img"
          aria-label={label}
          className="focus-ring block h-auto w-full"
        />
        <ManagedBrowserPointer presentation={presentation} viewer={current?.viewer} />
      </div>
    </section>
  );
}
