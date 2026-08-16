/**
 * Links that point at the docked profile — the current form, and every older one
 * still out there (spec `profile-unification` §1.6).
 *
 * Two hooks, mounted once at the app root:
 *
 * - {@link useProfileDockDeepLink} reads `?panel=profile&profilePage=…&agentPath=…`
 *   and opens the right panel on it.
 * - {@link useLegacyProfileLinkRedirect} rewrites the two older shapes — the
 *   Agent Hub's `?panel=agent-hub&hubTab=…` and the long-dead agent dialog's
 *   `?agent=…` / `?dialog=agent` — into that one, in place, so the link a person
 *   bookmarked still lands somewhere and the URL they end up on is the one this
 *   build speaks.
 *
 * Mounted at the ROOT, not inside the panel. Both used to live inside the hub
 * component, which meant a deep link only worked when the tab it was asking for
 * was already showing — the link could not open what it was addressed to.
 *
 * @module features/profile/model/use-profile-dock-deep-link
 */
import { useEffect, useRef } from 'react';
import { useAppStore, useInPlaceNavigate, useSafeSearch } from '@/layers/shared/model';
import { asProfilePageId, type ProfilePageId } from './profile-stack';
import { PROFILE_PANEL_ID, useProfileStore } from './profile-store';
import { useDockedAgentPath } from './use-docked-agent';

/** What `?panel=` said before the profile had a docked home. */
const LEGACY_PANEL_ID = 'agent-hub';

/**
 * The hub's inner tabs, and the older agent dialog's, mapped onto the pages that
 * replaced them.
 *
 * A tab with no successor page resolves to the profile's ROOT rather than to a
 * guess: Config and Toolkit were collections of rows that are now spread across
 * several pages and two popovers, so there is no single page a link to them
 * honestly means. `VALID_HUB_TABS` used to silently drop everything outside
 * `sessions|config` — which is how `?hubTab=toolkit` came to open Sessions
 * (`01-ideation.md` §3, bug 3). Every page is addressable now, so the table only
 * has to translate the names that changed.
 */
const LEGACY_TAB_PAGES: Record<string, ProfilePageId | null> = {
  sessions: 'sessions',
  tasks: 'tasks',
  tools: 'tools',
  // The agent dialog's channel membership tab. Rooms is the same list.
  channels: 'rooms',
  config: null,
  toolkit: null,
  identity: null,
  overview: null,
  profile: null,
  personality: null,
};

/** Translate a legacy tab name to the page that replaced it, or the root. */
function legacyTabPage(raw: unknown): ProfilePageId | undefined {
  return (typeof raw === 'string' ? LEGACY_TAB_PAGES[raw] : null) ?? undefined;
}

/**
 * The only four values the dead agent dialog ever put in `?agent=`.
 *
 * The param is NOT ours in general: `/team?view=topology&agent=<id>` uses it for
 * the topology's detail panel, and it is written and read there right now.
 * Treating any `?agent=` as the old dialog rewrote that link into a profile one
 * and the detail panel could never open. The old redirect had no such problem
 * only because it lived inside the Agent Hub, which `/team` never mounted.
 */
const LEGACY_DIALOG_TABS = new Set(['identity', 'personality', 'channels', 'tools']);

/**
 * Open the right panel on the profile when the URL asks for it.
 *
 * Applied once per distinct link rather than on every render of it: the panel
 * would otherwise snap back to the page the URL names each time anything the
 * effect watches moved, undoing a push the reader had just made. The link is
 * re-applied only when it changes — and once more if it named no agent and one
 * resolves later, which is the `/session?panel=profile` case where the working
 * directory arrives a beat after the route does.
 */
export function useProfileDockDeepLink(): void {
  const search = useSafeSearch() as { panel?: string; profilePage?: string; agentPath?: string };
  const openProfileDockedFromLink = useProfileStore((s) => s.openProfileDockedFromLink);
  const requestRightPanel = useAppStore((s) => s.requestRightPanel);
  const dockedAgentPath = useDockedAgentPath();

  const wantsProfile = search.panel === PROFILE_PANEL_ID;
  const urlAgentPath = search.agentPath ?? null;
  const page = asProfilePageId(search.profilePage) ?? undefined;
  // What makes one link different from another. Re-applying the same link is
  // what would fight the reader; applying a new one is the point.
  const linkKey = `${urlAgentPath ?? ''}|${page ?? ''}`;
  const applied = useRef<string | null>(null);

  useEffect(() => {
    if (!wantsProfile) {
      applied.current = null;
      return;
    }
    if (applied.current === linkKey) return;

    const target = urlAgentPath ?? dockedAgentPath;
    if (target) {
      applied.current = linkKey;
      openProfileDockedFromLink(target, page);
      return;
    }
    // The link named no agent and nothing else has picked one. Show the tab
    // anyway — a panel is what was asked for — and seed the page if an agent
    // resolves on a later pass.
    requestRightPanel(PROFILE_PANEL_ID);
  }, [
    wantsProfile,
    linkKey,
    urlAgentPath,
    dockedAgentPath,
    page,
    openProfileDockedFromLink,
    requestRightPanel,
  ]);
}

/**
 * Rewrite an older profile link into the current one, in place.
 *
 * `replace: true` so the dead URL does not become a place the back button can
 * return you to, and in place so the session-navigation guard does not read the
 * rewrite as leaving the page (DOR-928).
 */
export function useLegacyProfileLinkRedirect(): void {
  const search = useSafeSearch() as {
    panel?: string;
    hubTab?: string;
    agent?: string;
    dialog?: string;
  };
  const inPlaceNav = useInPlaceNavigate();

  const isLegacyPanel = search.panel === LEGACY_PANEL_ID;
  // Never on `!!search.agent`: see {@link LEGACY_DIALOG_TABS}. Either the param
  // that only the dialog ever wrote, or an `?agent=` naming one of its tabs.
  const isLegacyDialog =
    search.dialog === 'agent' || (!!search.agent && LEGACY_DIALOG_TABS.has(search.agent));
  const needsRedirect = isLegacyPanel || isLegacyDialog;
  // The hub's tab param and the dialog's; only one of the two is ever set.
  const legacyTab = isLegacyPanel ? search.hubTab : search.agent;

  useEffect(() => {
    if (!needsRedirect || !inPlaceNav) return;
    const page = legacyTabPage(legacyTab);

    inPlaceNav({
      search: (prev) => {
        const next = { ...prev };
        // Only the dialog's own params, and only when the dialog is what
        // brought us here — an `?agent=` this hook did not claim belongs to
        // whichever surface wrote it.
        if (isLegacyDialog) {
          delete next.agent;
          delete next.dialog;
        }
        delete next.hubTab;
        next.panel = PROFILE_PANEL_ID;
        // Only when the old tab has a successor: a link to Config asked for a
        // page that no longer exists, and the root is the honest answer.
        if (page) next.profilePage = page;
        else delete next.profilePage;
        return next;
      },
      replace: true,
    });
  }, [needsRedirect, isLegacyDialog, legacyTab, inPlaceNav]);
}
