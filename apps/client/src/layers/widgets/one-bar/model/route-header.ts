import type { ComponentType } from 'react';

/**
 * What a route declares as its bar, in `staticData.header`.
 *
 * A zero-prop component, because the shell renders it without knowing anything
 * about the route: whatever the bar needs beyond the URL it reads from
 * `useOneBarState`. `null` is for routes that have no bar of their own —
 * pathless layout routes, the root, and paths that only redirect.
 */
export type RouteHeader = ComponentType | null;

/** A route match, as much of one as {@link resolveRouteHeader} looks at. */
interface HeaderRouteMatch {
  routeId: string;
  staticData?: { header?: RouteHeader };
}

/** Which bar to render, and the key the cross-fade animates on. */
export interface ResolvedRouteHeader {
  /** `AnimatePresence` key — the BAR, not the route (see {@link barKey}). */
  key: string;
  /** The bar itself — never `null`; a chain that declares none resolves to `null` whole. */
  Header: NonNullable<RouteHeader>;
}

/**
 * One stable key per bar COMPONENT, so routes that share a bar share its key.
 *
 * **Why not the route id, which is what this was.** Four home routes declare the
 * same `HomeSurfaceBar`. Keyed by route, every tab press gave `AnimatePresence`
 * a new key — so it faded the whole bar out and a fresh one in, unmounting the
 * tab strip the person had just pressed. The strip lost its scroll position, the
 * `layoutId` underline could not slide (the element it would slide from was
 * gone), and the row dipped to zero opacity on a navigation where nothing in it
 * changes but which tab is lit. Keyed by the component, the same bar stays
 * mounted across those four routes and React reconciles it in place: the strip
 * is the same DOM node before and after, and the underline animates between
 * tabs the way it was always meant to.
 *
 * Routes with DIFFERENT bars still get different keys, so `/channels` → `/team`
 * cross-fades exactly as before.
 *
 * Identity, not name: a `WeakMap` keyed on the component itself. Two bars can
 * share a display name (and a production build may mangle both), which would
 * silently collapse two different bars onto one key — the DOR-587 failure mode
 * wearing a new hat.
 */
const BAR_KEYS = new WeakMap<NonNullable<RouteHeader>, string>();
let nextBarKey = 0;

/**
 * The cross-fade key for one bar component.
 *
 * @param Header - The bar a route declared.
 * @returns A key that is the same for every route declaring that same bar.
 */
function barKey(Header: NonNullable<RouteHeader>): string {
  const existing = BAR_KEYS.get(Header);
  if (existing !== undefined) return existing;
  const key = `bar-${nextBarKey++}`;
  BAR_KEYS.set(Header, key);
  return key;
}

/**
 * Find the bar for the route that is showing.
 *
 * Walks the match chain from the leaf back toward the root and takes the first
 * route that declares a header, so `/` — a leaf under the `_home` layout, which
 * declares `null` — gets its own bar rather than the layout's absence of one.
 *
 * This replaces a `pathname` switch in the shell. The switch's failure mode was
 * that a route could be added without anyone touching it and would silently
 * inherit the `default` branch's header, which is how every channel and every DM
 * once read "Dashboard" (DOR-587) and how Workspaces, Connections and Product
 * feedback did the same thing later (DOR-919). `staticData.header` is a required
 * option — `StaticDataRouteOption` is augmented with it, which is what makes
 * TanStack require `staticData` on every route — so a route with no header is
 * now a type error at the place the route is written, not a wrong word in the
 * header at runtime.
 *
 * @param matches - The router's current match chain, root first.
 */
export function resolveRouteHeader(
  matches: readonly HeaderRouteMatch[]
): ResolvedRouteHeader | null {
  for (let i = matches.length - 1; i >= 0; i--) {
    // Both reads are guarded. `staticData` is required by the module
    // augmentation, but this function is handed whatever the router has — and a
    // route built before that augmentation existed, or a hand-rolled match in a
    // test, carries neither. Answering `null` there is the same honest answer as
    // a chain that declares no bar; throwing on a missing key would turn a
    // shell that draws no header into a shell that draws nothing at all.
    const header = matches[i].staticData?.header;
    if (header) return { key: barKey(header), Header: header };
  }
  return null;
}
