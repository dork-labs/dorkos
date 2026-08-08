/**
 * Typed registry of the `data-testid` values the DorkBot living tour (and the
 * e2e capture pipeline) point at (ADR 260722-154341).
 *
 * Tours never mint a second `data-tour-id` attribute: they target the existing
 * `data-testid` convention. The subset that a tour or a capture depends on is
 * hoisted here so a rename is a compile-time event — the owning component, the
 * tour definitions, and the tests all import the same const, and a typo or a
 * drift breaks the build instead of silently pointing the spotlight at nothing.
 *
 * Values are the literal DOM `data-testid` strings. Keys are the authoring
 * surface (what tour steps and tests reference). Anchors are demand-driven: add
 * one only when a consumer points at it. `data-testid` is never stripped from
 * production builds, so these anchors resolve in every environment.
 *
 * @module shared/config/tour-anchors
 */

/**
 * The stable anchors a tour can spotlight, keyed by an authoring name and valued
 * by the `data-testid` string stamped on the owning component.
 */
export const TOUR_ANCHORS = {
  /** The dashboard composer where a first message to DorkBot is typed. */
  dashboardComposer: 'dashboard-composer',
  /** The home surface's tab bar: Home, Activity, Scheduled, Workspaces. */
  homeTabs: 'home-tabs',
  /** The Team page's roster of every person and agent on this install. */
  teamRoster: 'team-roster',
  /**
   * The sidebar navigation button that opens the Team page.
   *
   * Named for the page's old title, and staying that way: the `data-testid` is
   * what the e2e specs click, so renaming it would break them for a rename
   * nobody would ever see.
   *
   * **No tour points here, and none should.** On a phone the sidebar is a sheet
   * that is unmounted while closed, so a step anchored inside it resolves on a
   * desktop and silently times out on a phone. Tours spotlight the page, not the
   * chrome that opens it.
   */
  navAgents: 'nav-agents',
  /** The Relay integrations list inside settings. */
  relayIntegrations: 'connections-messaging',
  /** The Tasks page scheduled-work list. */
  tasksList: 'tasks-list',
  /**
   * Three throwaway targets the Dev Playground's spotlight showcase stamps on
   * boxes of its own.
   *
   * They exist so the showcase never borrows a product anchor: the playground
   * renders inside the real shell, and a duplicate `data-testid` leaves the
   * spotlight pointing at whichever copy the DOM hands back first.
   */
  playgroundStep1: 'tour-playground-1',
  /** See {@link TOUR_ANCHORS.playgroundStep1}. */
  playgroundStep2: 'tour-playground-2',
  /** See {@link TOUR_ANCHORS.playgroundStep1}. */
  playgroundStep3: 'tour-playground-3',
  /**
   * The one anchor nothing stamps, ever. The playground points a demo tour at
   * it to show the honest timeout-skip, which needs a target that never arrives.
   */
  playgroundMissing: 'tour-playground-missing',
} as const;

/** The authoring keys of {@link TOUR_ANCHORS}. */
export type TourAnchorKey = keyof typeof TOUR_ANCHORS;

/**
 * A resolvable anchor: the `data-testid` string a tour step targets. Always one
 * of the {@link TOUR_ANCHORS} values, so a step can never reference an anchor
 * that no component stamps.
 */
export type TourAnchorId = (typeof TOUR_ANCHORS)[TourAnchorKey];

/**
 * A single spotlight step: the anchor to spotlight, the caption DorkBot speaks,
 * and the label of the chip that advances the tour. Authored as data by the tour
 * engine; consumed by {@link TourSpotlight}.
 */
export interface TourStep {
  /** The anchor to resolve and spotlight (a {@link TOUR_ANCHORS} value). */
  anchor: TourAnchorId;
  /** DorkBot's line for this step. Names the target in plain language. */
  caption: string;
  /** The advance chip's label. Defaults to a generic "Next" when omitted. */
  chipLabel?: string;
}

/** The CSS selector that resolves a tour anchor in the DOM. */
export function tourAnchorSelector(anchor: TourAnchorId): string {
  return `[data-testid="${anchor}"]`;
}
