import { DORKBOT_TOUR_LINES } from '@dorkos/shared/dorkbot-templates';
import { TOUR_ANCHORS, type TourStep } from '@/layers/shared/config';

/** Every tour DorkBot can run. Occasion tours share their id with their trigger. */
export type TourId = 'general' | 'tasks' | 'relay' | 'mesh';

/** The occasion tours — the ones offered on an observed first use. */
export type TourOccasion = 'tasks' | 'relay' | 'mesh';

/**
 * Where a tour sends the user before its first step resolves. Pure data: the
 * engine ({@link TourHost}) executes it with the router / app store, so the
 * definitions stay side-effect free.
 */
export type TourDeepLink =
  | { kind: 'route'; to: string }
  | { kind: 'settings-tab'; tab: string }
  | { kind: 'none' };

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
        anchor: TOUR_ANCHORS.yourAgents,
        caption: DORKBOT_TOUR_LINES.general.yourAgents,
        chipLabel: 'Next',
      },
      {
        anchor: TOUR_ANCHORS.navTasks,
        caption: DORKBOT_TOUR_LINES.general.navTasks,
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
    deepLink: { kind: 'settings-tab', tab: 'channels' },
    steps: [
      {
        anchor: TOUR_ANCHORS.relayChannels,
        caption: DORKBOT_TOUR_LINES.relay.relayChannels,
        chipLabel: 'Got it',
      },
    ],
  },
  mesh: {
    id: 'mesh',
    occasion: 'mesh',
    offerLine: DORKBOT_TOUR_LINES.offers.mesh,
    // The Agents nav lives in the always-visible sidebar, so no navigation is needed.
    deepLink: { kind: 'none' },
    steps: [
      {
        anchor: TOUR_ANCHORS.navAgents,
        caption: DORKBOT_TOUR_LINES.mesh.navAgents,
        chipLabel: 'Got it',
      },
    ],
  },
};
