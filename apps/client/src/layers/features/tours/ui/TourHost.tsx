import { useEffect } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';

import { useAppStore } from '@/layers/shared/model';
import { TourSpotlight } from '@/layers/shared/ui';

import { TOUR_DEFINITIONS, type TourId } from '../model/tour-definitions';
import { useTours } from '../model/use-tours';
import { useTourOccasions } from '../model/use-tour-occasions';

/**
 * Mounts the living tour once, high in the app tree: it runs occasion detection,
 * deep-links to the running tour's surface, and renders the spotlight. Deep-links
 * are executed here (not in the pure tour definitions) so navigation stays a
 * side effect the host owns.
 */
export function TourHost() {
  useTourOccasions();

  const { runningDefinition, activeIndex, advanceStep, endTour, runTour } = useTours();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const openSettingsToTab = useAppStore((s) => s.openSettingsToTab);
  const requestedTour = useAppStore((s) => s.requestedTour);
  const clearRequestedTour = useAppStore((s) => s.clearRequestedTour);

  const runningTourId = runningDefinition?.id ?? null;

  // Consume a tour requested from elsewhere (the "Show me around" doors set it
  // through the app store so features that cannot import tours can still launch).
  //
  // DEFERRED, NEVER DROPPED: the request is held until the tour is actually
  // running. On a cold page load the app store and the tours engine re-render as
  // TanStack queries settle; the old code cleared the request in the same tick it
  // started the tour, on an effect whose deps changed every render, so a settling
  // re-render landing between the click and the start could clear the request
  // before the launch committed — the tour silently never ran. Now `runTour` is
  // the store's stable action (stable deps, no per-render churn) and the request
  // is only cleared once `runningTourId` reflects it, so an interrupted start
  // simply retries on the next render instead of being lost.
  useEffect(() => {
    if (requestedTour === null) return;
    if (!(requestedTour in TOUR_DEFINITIONS)) {
      clearRequestedTour(); // unknown id: nothing to run
      return;
    }
    if (runningTourId === requestedTour) {
      clearRequestedTour(); // the tour is running — the hand-off is complete
      return;
    }
    runTour(requestedTour as TourId); // start it, but hold the request until it runs
  }, [requestedTour, runningTourId, runTour, clearRequestedTour]);

  useEffect(() => {
    if (!runningDefinition) return;
    const link = runningDefinition.deepLink;
    if (link.kind === 'route') {
      // Only navigate when we are not already on the target route: a redundant
      // navigate to the current path can remount the dashboard mid-launch and
      // yank the anchor out from under the spotlight while it is resolving.
      if (pathname !== link.to) navigate({ to: link.to });
    } else if (link.kind === 'settings-tab') {
      openSettingsToTab(link.tab);
    }
  }, [runningDefinition, pathname, navigate, openSettingsToTab]);

  if (!runningDefinition) return null;

  return (
    <TourSpotlight
      steps={runningDefinition.steps}
      activeIndex={activeIndex}
      onAdvance={advanceStep}
      onEnd={endTour}
    />
  );
}
