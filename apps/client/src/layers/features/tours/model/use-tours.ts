import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTransport } from '@/layers/shared/model';
import type { ToursState } from '@dorkos/shared/config-schema';

import {
  TOUR_DEFINITIONS,
  type TourDefinition,
  type TourId,
  type TourOccasion,
} from './tour-definitions';
import { useTourStore } from './tour-store';

const CONFIG_KEY = ['config'] as const;

/** The engine's public surface. */
export interface UseToursResult {
  /** Ids of tours the user has run (accepted or launched on demand). */
  seen: string[];
  /** Ids of occasion tours the user declined. */
  declined: string[];
  /** Whether an occasion has been seen or declined (so it never re-offers). */
  isSuppressed: (id: TourId) => boolean;
  /** The definition of the running tour, or null. */
  runningDefinition: TourDefinition | null;
  /** The active step index of the running tour. */
  activeIndex: number;
  /** The definition of the occasion tour currently being offered, or null. */
  pendingOffer: TourDefinition | null;
  /** The id of the pending offer, or null. */
  pendingOfferId: TourOccasion | null;
  /** Launch a tour directly (the on-demand "Show me around" door). */
  runTour: (id: TourId) => void;
  /** Accept an offered occasion tour: mark it seen and run it. */
  acceptOffer: (id: TourOccasion) => void;
  /** Decline an offered occasion tour: mark it declined, never re-offer. */
  declineOffer: (id: TourOccasion) => void;
  /** Offer an occasion tour (used by the occasion detector). */
  setPendingOffer: (id: TourOccasion) => void;
  /** Advance the running tour to its next step. */
  advanceStep: () => void;
  /** End the running tour. */
  endTour: () => void;
}

/**
 * The living-tour engine: bridges the ephemeral runtime store (which tour is
 * running / offered) with the persistent config `tours` block (seen / declined).
 *
 * Accepting an offer marks the tour seen and runs it; declining marks it
 * declined so it never re-offers. Persistence mirrors the onboarding pattern:
 * read from `GET /api/config`, write partial patches via `PATCH /api/config`
 * (the server deep-merges, so a `seen`-only patch keeps `declined`).
 */
export function useTours(): UseToursResult {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const { data: config } = useQuery({
    queryKey: [...CONFIG_KEY],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });

  const seen = config?.tours?.seen ?? [];
  const declined = config?.tours?.declined ?? [];

  const runningTourId = useTourStore((s) => s.runningTourId);
  const activeIndex = useTourStore((s) => s.activeIndex);
  const pendingOfferId = useTourStore((s) => s.pendingOfferId);
  const startTour = useTourStore((s) => s.startTour);
  const advanceStep = useTourStore((s) => s.advanceStep);
  const endTour = useTourStore((s) => s.endTour);
  const setPendingOffer = useTourStore((s) => s.setPendingOffer);
  const clearPendingOffer = useTourStore((s) => s.clearPendingOffer);

  const patchTours = useMutation({
    mutationFn: (patch: Partial<ToursState>) => transport.updateConfig({ tours: patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...CONFIG_KEY] }),
    onError: () => toast.error('Could not save your tour progress.'),
  });

  function markSeen(id: TourId) {
    if (seen.includes(id)) return;
    patchTours.mutate({ seen: [...seen, id] });
  }

  function markDeclined(id: TourOccasion) {
    if (declined.includes(id)) return;
    patchTours.mutate({ declined: [...declined, id] });
  }

  function isSuppressed(id: TourId): boolean {
    return seen.includes(id) || declined.includes(id);
  }

  function runTour(id: TourId) {
    startTour(id);
  }

  function acceptOffer(id: TourOccasion) {
    markSeen(id);
    startTour(id);
  }

  function declineOffer(id: TourOccasion) {
    markDeclined(id);
    clearPendingOffer();
  }

  return {
    seen,
    declined,
    isSuppressed,
    runningDefinition: runningTourId ? TOUR_DEFINITIONS[runningTourId] : null,
    activeIndex,
    pendingOffer: pendingOfferId ? TOUR_DEFINITIONS[pendingOfferId] : null,
    pendingOfferId,
    runTour,
    acceptOffer,
    declineOffer,
    setPendingOffer,
    advanceStep,
    endTour,
  };
}
