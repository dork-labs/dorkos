import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';

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
  const openSettingsToTab = useAppStore((s) => s.openSettingsToTab);
  const requestedTour = useAppStore((s) => s.requestedTour);
  const clearRequestedTour = useAppStore((s) => s.clearRequestedTour);

  // Consume a tour requested from elsewhere (the "Show me around" doors set it
  // through the app store so features that cannot import tours can still launch).
  useEffect(() => {
    if (requestedTour === null) return;
    if (requestedTour in TOUR_DEFINITIONS) {
      runTour(requestedTour as TourId);
    }
    clearRequestedTour();
  }, [requestedTour, runTour, clearRequestedTour]);

  useEffect(() => {
    if (!runningDefinition) return;
    const link = runningDefinition.deepLink;
    if (link.kind === 'route') {
      navigate({ to: link.to });
    } else if (link.kind === 'settings-tab') {
      openSettingsToTab(link.tab);
    }
  }, [runningDefinition, navigate, openSettingsToTab]);

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
