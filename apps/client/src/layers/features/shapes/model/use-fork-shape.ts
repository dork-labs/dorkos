/**
 * Make-your-own-version mutation for the switcher UI (DOR-402).
 *
 * Forks the *active* Shape into a new one, carrying the arrangement the person
 * is living in: the server reads the enabled extensions for itself, and this
 * hook snapshots the live chrome it cannot see ({@link captureShapeLayout}).
 * The capture is partial by design — every field it omits keeps the source
 * Shape's value, so the fork never records chrome nobody chose.
 *
 * The new Shape is deliberately NOT applied: the arrangement already on screen
 * IS the new Shape, so applying it would be a confusing no-op.
 *
 * Reporting a failure is this hook's job, and it lands in exactly one place
 * (DOR-453). The caller says whether the inline name field is still on screen —
 * asked the moment the request fails, not when it was sent — and if it is not,
 * the failure arrives as a toast that names the actual problem. That is why the
 * app-wide generic mutation toast stays opted out: it would either talk over the
 * inline message or replace a specific reason with "Action failed".
 *
 * @module features/shapes/model/use-fork-shape
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ForkShapeResult } from '@dorkos/shared/marketplace-schemas';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { captureShapeLayout, shapeKeys } from '@/layers/entities/shapes';

/** Variables for the fork mutation. */
export interface ForkShapeVars {
  /** The installed Shape to copy (the active one). */
  name: string;
  /** The new Shape's name (kebab-case). */
  as: string;
}

/** Options for {@link useForkShape}. */
export interface UseForkShapeOptions {
  /**
   * Whether the inline name field is on screen, so it can render the refusal
   * itself.
   *
   * Called when the request fails, which is always later than the render that
   * supplied this callback — and possibly after the field, or the whole
   * switcher, is gone. So it has to read live state, not close over a snapshot.
   *
   * Answering `true` promises the field is still wired to *this* mutation's error
   * state. Calling `reset()` on a copy that is still in flight breaks that
   * promise — it detaches the observer, so the error the field renders from never
   * arrives, while this callback keeps the toast away.
   */
  isInlineErrorVisible: () => boolean;
}

/**
 * Copy the active Shape into a new one, capturing the live arrangement.
 *
 * @param options - How to reach the inline error surface, if there still is one.
 * @returns The fork mutation — `mutate({ name, as })` copies the Shape with the
 *   live arrangement captured, then refreshes the installed-Shapes list so the
 *   copy appears with its "forked from …" caption.
 */
export function useForkShape({ isInlineErrorVisible }: UseForkShapeOptions) {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<ForkShapeResult, Error, ForkShapeVars>({
    // This hook reports the failure itself, in one of two places (see the module
    // note). The generic toast is never one of them.
    meta: { suppressErrorToast: true },
    mutationFn: ({ name, as }) => {
      // Read the store fresh at submit time so the capture reflects the chrome
      // as it stands now, not as it stood when the form opened.
      const s = useAppStore.getState();
      return transport.forkShape(name, {
        as,
        captureCurrent: true,
        liveLayout: captureShapeLayout({
          sidebarOpen: s.sidebarOpen,
          settingsOpen: s.settingsOpen,
          tasksOpen: s.tasksOpen,
          relayOpen: s.relayOpen,
          pickerOpen: s.pickerOpen,
        }),
      });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: shapeKeys.all });
      toast.success(`Saved your version as ${result.name}`);
    },
    // Runs whether or not anything is still watching this mutation — TanStack
    // keeps the mutation's own callbacks even after its observer unmounts, which
    // is exactly the case this exists for.
    onError: (error) => {
      // With the field on screen, the form shows WHICH name is taken right next
      // to the thing you have to edit — the most useful place there is, so we
      // stay quiet. With the field gone (you left while the copy was in flight)
      // a toast is all that is left, and it still names the real problem.
      if (isInlineErrorVisible()) return;
      toast.error("Couldn't save your version", { description: error.message });
    },
  });
}
