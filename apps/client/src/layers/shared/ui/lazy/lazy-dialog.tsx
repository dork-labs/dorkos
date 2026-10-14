/**
 * A dialog whose code is fetched the first time it is wanted (DOR-2901).
 *
 * The app's dialogs mount from the start with `open={false}` (the dialog host
 * keeps every one ready), so importing one statically put all of its code in
 * the first download every page waits for, even though most visits never open
 * it. This stands in for such a dialog: it renders nothing until it is first
 * opened, and asks the browser for the real one once the app is idle, so that
 * first open is normally instant too.
 *
 * A download that fails (offline, or a tab left open across an update) closes
 * the dialog and says so; the next open tries again. Left alone, the failure
 * would reach the router and replace the whole app with an error page. The
 * same catch holds a loaded dialog that crashes while drawing: it closes with
 * a note instead of taking the page down, and opening it again draws it again.
 *
 * The slice that owns a dialog builds its stand-in, importing the real dialog
 * by its own relative path: a barrel is already in the first download, so a
 * dynamic import of one splits nothing.
 *
 * @module shared/ui/lazy/lazy-dialog
 */
import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { toast } from 'sonner';
import { isDynamicImportError } from '@/layers/shared/lib/dynamic-import-error';

/** The props every lazily loaded dialog takes. */
interface OpenableProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when the dialog asks to open or close. */
  onOpenChange?: (open: boolean) => void;
}

/** Ask for something once the browser is idle, or after a short wait without the API. */
function whenIdle(task: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(task, { timeout: 10_000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(task, 3_000);
  return () => clearTimeout(id);
}

/**
 * Build a stand-in for a dialog that is fetched on first open.
 *
 * Once opened it stays mounted, so closing animates and reopening keeps its
 * state, as the eagerly loaded dialog did.
 *
 * @param name - The dialog's name, shown in React DevTools.
 * @param load - Fetches the real dialog component.
 * @returns A component taking the dialog's own props.
 */
export function lazyDialog<P extends OpenableProps>(
  name: string,
  load: () => Promise<ComponentType<P>>
): ComponentType<P> {
  let loaded = false;
  const fetchDialog = () =>
    load().then((component) => {
      loaded = true;
      return component;
    });

  function LazyDialog(props: P) {
    const [wanted, setWanted] = useState(props.open);
    // After a failure the dialog is still "open" until the caller's close lands
    // (a router update, for a deep-linked dialog). Wanting it again then would
    // retry at once instead of on the next open, so wait for a closed render.
    const [failed, setFailed] = useState(false);
    if (failed && !props.open) setFailed(false);
    if (props.open && !wanted && !failed) setWanted(true);
    // A new lazy instance per failed attempt: React caches a rejected one, so
    // reusing it would fail again without asking.
    const [attempt, setAttempt] = useState(0);
    const Loaded = useMemo(
      () => lazy(() => fetchDialog().then((component) => ({ default: component }))),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `attempt` is the retry key
      [attempt]
    );

    useEffect(() => {
      if (loaded) return;
      return whenIdle(() => void fetchDialog().catch(() => {}));
    }, []);

    if (!wanted) return null;
    return (
      <ErrorBoundary
        resetKeys={[attempt]}
        fallback={null}
        onError={(error) => {
          const updated = error instanceof Error && isDynamicImportError(error);
          setWanted(false);
          setFailed(true);
          setAttempt((n) => n + 1);
          props.onOpenChange?.(false);
          // One toast per dialog, however many times it is tried meanwhile.
          if (updated) {
            toast.error('DorkOS may have updated. Reload to open this.', {
              id: `lazy-dialog-${name}`,
              action: { label: 'Reload', onClick: () => window.location.reload() },
            });
          } else {
            toast.error('Couldn’t open that. Try again.', { id: `lazy-dialog-${name}` });
          }
        }}
      >
        <Suspense fallback={null}>
          <Loaded {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  }
  LazyDialog.displayName = `Lazy(${name})`;
  return LazyDialog;
}
