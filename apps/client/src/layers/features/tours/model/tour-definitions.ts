import { DORKBOT_TOUR_LINES } from '@dorkos/shared/dorkbot-templates';
import { TOUR_ANCHORS, type TourStep } from '@/layers/shared/config';

/** Every tour DorkBot can run. Occasion tours share their id with their trigger. */
export type TourId = 'general' | 'tasks' | 'relay' | 'mesh';

/** The occasion tours — the ones offered on an observed first use. */
export type TourOccasion = 'tasks' | 'relay' | 'mesh';

/**
 * Where a tour sends the user before its first step resolves. Pure data: the
 * engine ({@link TourHost}) executes it with the router, so the definitions stay
 * side-effect free.
 *
 * **Every tour goes somewhere.** There used to be a `none` variant, for a tour
 * of the chrome that needed no navigation. It is gone with the step that used
 * it: the sidebar it pointed at is a sheet on a phone, unmounted while closed,
 * so a tour of the chrome shows a phone nothing. Tours open a page.
 */
export type TourDeepLink = { kind: 'route'; to: string };

/** A tour as data: its steps, where it opens, and (for occasions) its offer. */
export interface TourDefinition {
  /** Stable id, also the key in the config `tours` block. */
  id: TourId;
  /** Ordered spotlight steps (captions from `dorkbot-templates`). */
  steps: TourStep[];
  /** Where to go before resolving the first anchor. */
  deepLink: TourDeepLink;
  /** The occasion that offers this tour, when it is occasion-driven. */
  occasion?: TourOccasion;
  /** DorkBot's offer line, shown as a suggestion chip (occasion tours only). */
  offerLine?: string;
}

/**
 * The tour catalog. The general tour is on-demand ("Show me around"); the other
 * three introduce a subsystem at first genuine use. Each is three steps or fewer
 * and points at a real, already-created referent.
 */
export const TOUR_DEFINITIONS: Record<TourId, TourDefinition> = {
  general: {
    id: 'general',
    deepLink: { kind: 'route', to: '/' },
    steps: [
      {
        anchor: TOUR_ANCHORS.dashboardComposer,
        caption: DORKBOT_TOUR_LINES.general.composer,
        chipLabel: 'Next',
      },
      {
        anchor: TOUR_ANCHORS.homeTabs,
        caption: DORKBOT_TOUR_LINES.general.homeTabs,
        chipLabel: 'Got it',
      },
    ],
  },
  tasks: {
    id: 'tasks',
    occasion: 'tasks',
    offerLine: DORKBOT_TOUR_LINES.offers.tasks,
    deepLink: { kind: 'route', to: '/tasks' },
    steps: [
      {
        anchor: TOUR_ANCHORS.tasksList,
        caption: DORKBOT_TOUR_LINES.tasks.tasksList,
        chipLabel: 'Got it',
      },
    ],
  },
  relay: {
    id: 'relay',
    occasion: 'relay',
    offerLine: DORKBOT_TOUR_LINES.offers.relay,
    deepLink: { kind: 'route', to: '/connections' },
    steps: [
      {
        anchor: TOUR_ANCHORS.relayIntegrations,
        caption: DORKBOT_TOUR_LINES.relay.relayIntegrations,
        chipLabel: 'Got it',
      },
    ],
  },
  mesh: {
    id: 'mesh',
    occasion: 'mesh',
    offerLine: DORKBOT_TOUR_LINES.offers.mesh,
    // Onto the Team page, rather than spotlighting the sidebar button that opens
    // it. The offer promises to show the fleet, and the sidebar is a sheet on a
    // phone: unmounted while closed, so a step anchored in it would have shown a
    // phone nothing at all.
    deepLink: { kind: 'route', to: '/team' },
    steps: [
      {
        anchor: TOUR_ANCHORS.teamRoster,
        caption: DORKBOT_TOUR_LINES.mesh.teamRoster,
        chipLabel: 'Got it',
      },
    ],
  },
};
