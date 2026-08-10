/**
 * The one call to {@link buildSidebarModel} in the running application.
 *
 * One call, one place: the model is a pure function of a memoized snapshot, so
 * a second caller would be a second tree built from the same facts — twice the
 * work and a chance for two parts of the panel to disagree about what the
 * sidebar contains.
 *
 * @module features/dashboard-sidebar/model/use-sidebar-model
 */
import { useMemo } from 'react';
import { buildSidebarModel, type SidebarModel } from './build-sidebar-model';
import type { SidebarState } from './sidebar-state';

/**
 * The whole sidebar, rebuilt only when the snapshot it is a function of moves.
 *
 * The dependency is the state OBJECT, which `useSidebarState` keeps
 * referentially stable across everything that does not change what the panel
 * says — an activity event above all (spec §H, Risk R1).
 *
 * It takes the snapshot rather than calling `useSidebarState` itself so that
 * the panel assembles state exactly once: the renderer needs both halves, and
 * a hook that fetched its own would mean two coarse clocks and two assemblies
 * of the same facts.
 *
 * @param state - The snapshot from `useSidebarState`.
 */
export function useSidebarModel(state: SidebarState): SidebarModel {
  return useMemo(() => buildSidebarModel(state), [state]);
}
