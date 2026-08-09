/**
 * The one mapping from stored sidebar prefs to the view the sidebar model reads.
 *
 * `buildSidebarModel` takes a snapshot of application state, and `prefs` is one
 * field of it. It must not take {@link SidebarPrefs} directly: that type is the
 * SHAPE ON DISK, it changes when config schema changes, and a pure model whose
 * input type moves every time a migration lands is a model nobody can test
 * against a fixture. {@link SidebarModelPrefs} is the narrower thing the model
 * actually consults, and this module is the only place the two meet.
 *
 * It also does the one job a straight structural copy could not: it makes the
 * nested blocks total. Zod's defaults guarantee `sections`, `gettingStarted` and
 * `digest` on anything it has parsed, but the client reads config over the wire
 * and an install whose conf migration has not run yet (a dev tree resolves
 * `SERVER_VERSION` to `0.0.0` and runs none at all) can hand back an object with
 * those keys simply absent. The model gets a complete view either way.
 *
 * @module entities/config/model/sidebar-model-prefs
 */
import type {
  SidebarPrefs,
  SidebarGroup,
  SidebarItemRef,
  SidebarSectionId,
  SidebarSectionPrefs,
} from '@dorkos/shared/config-schema';
import { normalizeSidebarPrefs } from '@dorkos/shared/config-schema';

/**
 * What the sidebar model is allowed to know about the person's stored prefs.
 *
 * Everything here is read-only: the model derives, it never writes. Writes go
 * through `useUpdateSidebarPrefs` and the pure mutators beside it.
 */
export interface SidebarModelPrefs {
  /** Ordered pins — the Library's Pins section, in the person's own order. */
  readonly pinned: readonly SidebarItemRef[];
  /** Manual and smart groups — sub-headers inside Library ▸ Agents. */
  readonly groups: readonly SidebarGroup[];
  /** Individually muted items. Mute owns every attention signal at once. */
  readonly muted: readonly SidebarItemRef[];
  /** Per-section collapse and options. A section with no entry has no state. */
  readonly sections: Readonly<Partial<Record<SidebarSectionId, SidebarSectionPrefs>>>;
  /** Getting started's memory: suggestions this person has finished with. */
  readonly gettingStarted: { readonly retired: readonly string[] };
  /** The welcome-back digest's memory: the local date it last appeared on. */
  readonly digest: { readonly lastShownDate?: string };
}

/**
 * Project stored sidebar prefs onto the view the model reads.
 *
 * Pure and total: every field of the result is present whatever the input was
 * missing. Membership lists are normalized first, so the model never has to know
 * that a config written before DOR-579 stores bare agent paths.
 *
 * @param prefs - Sidebar prefs as read from config.
 * @returns The model's view of them.
 */
export function toSidebarModelPrefs(prefs: SidebarPrefs): SidebarModelPrefs {
  // Every `?? …` here is load-bearing: the declared type says these are present,
  // and a config read from an install whose migration has not run says otherwise.
  // The lists are filled BEFORE normalizing, not after — `normalizeSidebarPrefs`
  // reads each one and would throw on an absent `pinned`.
  const canonical = normalizeSidebarPrefs({
    ...prefs,
    pinned: prefs.pinned ?? [],
    groups: prefs.groups ?? [],
    muted: prefs.muted ?? [],
  });
  return {
    pinned: canonical.pinned,
    groups: canonical.groups,
    muted: canonical.muted,
    sections: canonical.sections ?? {},
    gettingStarted: { retired: canonical.gettingStarted?.retired ?? [] },
    digest: { lastShownDate: canonical.digest?.lastShownDate },
  };
}
