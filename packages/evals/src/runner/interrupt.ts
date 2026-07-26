/**
 * Interrupt-safe teardown: run every live eval's disposer when the harness is
 * interrupted, then let the signal do its job.
 *
 * Without this, `Ctrl-C` during a suite skips `runEval`'s `finally` block
 * entirely — the sandbox directory stays on disk and, on the docker tier, the
 * container keeps RUNNING (holding its port and its bind mount). The docker
 * launcher's own docstring promises a "greppable, sweepable set" of strays; this
 * module is the half that keeps the set from growing in the first place, and
 * {@link sweepStrays} (see `sweep.ts`) is the half that clears what a hard kill
 * still leaves behind.
 *
 * Handlers are installed LAZILY on the first registration and removed once the
 * last disposer unregisters, so importing the harness never changes a host
 * process's signal behavior.
 *
 * @module evals/runner/interrupt
 */

/** The signals a harness run treats as "tear down now". */
const INTERRUPT_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/** Live disposers, in registration order. */
const disposers = new Set<() => Promise<void>>();

/** Installed handlers, so they can be removed when the last disposer goes. */
let installed: { signal: NodeJS.Signals; handler: () => void }[] = [];

/** Guard against a second signal re-entering teardown while the first runs. */
let tearingDown = false;

/**
 * Run every registered disposer, swallowing individual failures so one stuck
 * container cannot strand the rest, then re-raise the signal with handlers
 * removed so the process exits the way the operator asked it to.
 */
async function tearDown(signal: NodeJS.Signals): Promise<void> {
  if (tearingDown) return;
  tearingDown = true;
  process.stderr.write(
    `\nReceived ${signal} — disposing ${disposers.size} live eval resource(s).\n`
  );
  for (const dispose of [...disposers]) {
    try {
      await dispose();
    } catch {
      // A disposer that cannot finish must not block the others; the sweep
      // (`pnpm evals:sweep`) is the backstop for whatever it left behind.
    }
  }
  disposers.clear();
  removeHandlers();
  process.kill(process.pid, signal);
}

/** Attach the signal handlers (idempotent). */
function installHandlers(): void {
  if (installed.length > 0) return;
  installed = INTERRUPT_SIGNALS.map((signal) => {
    const handler = (): void => {
      void tearDown(signal);
    };
    process.on(signal, handler);
    return { signal, handler };
  });
}

/** Detach the signal handlers, restoring the process's default behavior. */
function removeHandlers(): void {
  for (const { signal, handler } of installed) process.off(signal, handler);
  installed = [];
}

/**
 * Register `dispose` to run if the harness is interrupted.
 *
 * @param dispose - Teardown for one eval's resources (server + sandbox). Must be
 *   idempotent: the normal `finally` path may already have run it.
 * @returns An unregister thunk to call once the eval has torn itself down.
 */
export function onInterrupt(dispose: () => Promise<void>): () => void {
  disposers.add(dispose);
  installHandlers();
  return () => {
    disposers.delete(dispose);
    if (disposers.size === 0) removeHandlers();
  };
}

/** How many disposers are currently registered (for tests and diagnostics). */
export function liveDisposerCount(): number {
  return disposers.size;
}
