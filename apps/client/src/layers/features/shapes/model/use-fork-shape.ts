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

/**
 * Copy the active Shape into a new one, capturing the live arrangement.
 *
 * @returns The fork mutation — `mutate({ name, as })` copies the Shape with the
 *   live arrangement captured, then refreshes the installed-Shapes list so the
 *   copy appears with its "forked from …" caption.
 */
export function useForkShape() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<ForkShapeResult, Error, ForkShapeVars>({
    // The form renders the failure itself — a name conflict has to say WHICH
    // name is taken. The generic mutation toast would talk over it.
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
  });
}
