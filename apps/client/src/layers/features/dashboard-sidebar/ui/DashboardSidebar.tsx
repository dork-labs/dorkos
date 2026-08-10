/**
 * The sidebar body: a landmark, a drag layer, and the zones.
 *
 * It was 875 lines of rules in JSX. Everything it used to decide — which rows
 * appear, in what order, under what cap, with what badge — is now
 * `buildSidebarModel`, and this composes the three things a renderer needs: the
 * `<nav>` landmark, the drag layer, and `SidebarZones`.
 *
 * **It computes no membership, order, cap or badge.** That is a rule with a
 * test behind it (`DashboardSidebar.test.tsx`), not an aspiration — the whole
 * point of the model is that a component cannot quietly grow a second opinion
 * about what the sidebar contains.
 *
 * The header block and the footer strip are NOT here: they are persistent
 * chrome mounted in `AppShell`, outside the `sidebar.body` swap region, so a
 * marketplace takeover replaces the body and leaves them standing (spec R2,
 * P2 AC-8). P2.4 and P2.5 fill those mount points.
 *
 * @module features/dashboard-sidebar/ui/DashboardSidebar
 */
import { useEffect, useMemo, useRef } from 'react';
import { SidebarContent } from '@/layers/shared/ui';
import { useConfig, useSidebarPrefs, useUpdateSidebarPrefs } from '@/layers/entities/config';
import { PromoSlot } from '@/layers/features/feature-promos';
import { useAgentCreationStore } from '@/layers/shared/model';
import { useSidebarModel } from '../model/use-sidebar-model';
import { useSidebarState } from '../model/use-sidebar-state';
import { AgentOnboardingCard } from './AgentOnboardingCard';
import { SidebarChrome } from './SidebarChrome';
import { SidebarDnd } from './dnd/SidebarDnd';
import { SidebarZones } from './SidebarZones';

/**
 * Legacy localStorage key that held pinned agent paths before organization moved
 * to server config (DOR-329). Its presence IS the one-time migration flag.
 */
const LEGACY_PINNED_STORAGE_KEY = 'dorkos-pinned-agents';

/**
 * One-time migration of legacy localStorage pins into server config (DOR-329).
 *
 * Unchanged by the redesign, and deliberately so: it has its own deprecation
 * clock. If the old key exists and the server has no pins yet, the server pins
 * are seeded from it in order; server state wins when it already has pins. The
 * key is removed either way, so re-mounts and reloads are no-ops.
 */
function useLegacyPinMigration(): void {
  const { data: config } = useConfig();
  const sidebarPrefs = useSidebarPrefs();
  const { update: updateSidebarPrefs } = useUpdateSidebarPrefs();
  const pinnedCount = sidebarPrefs.pinned.length;
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;
    if (config === undefined) return; // wait for real server config
    const raw = localStorage.getItem(LEGACY_PINNED_STORAGE_KEY);
    if (raw === null) {
      doneRef.current = true;
      return;
    }
    doneRef.current = true;
    let stored: string[] = [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) stored = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      stored = [];
    }
    if (pinnedCount === 0 && stored.length > 0) {
      updateSidebarPrefs((prev) => ({
        ...prev,
        pinned: stored.map((path) => ({ kind: 'agent', path })),
      }));
    }
    localStorage.removeItem(LEGACY_PINNED_STORAGE_KEY);
  }, [config, pinnedCount, updateSidebarPrefs]);
}

/**
 * The dashboard sidebar — Now, Today and Library, drawn from one model.
 *
 * Pins, channels, direct messages, agents and groups all stay exactly where
 * they were put: Library is the operator's own structure and nothing reorders
 * it (BC-28 → BC-33). Now and Today above it are computed, and are the only
 * parts of the panel that move on their own.
 */
export function DashboardSidebar() {
  useLegacyPinMigration();
  const state = useSidebarState();
  const model = useSidebarModel(state);
  const roomTitles = useMemo(
    () => Object.fromEntries(state.rooms.map((room) => [room.id, room.slug ?? room.title])),
    [state.rooms]
  );
  // "Is there anything at all yet?" — a presence check on the model, not a
  // membership rule. Library is absent only when there is no agent, no room and
  // no pin to put in it, which is the one moment the invitation belongs on
  // screen. P2.2's Getting started zone takes this over.
  const isEmpty = !model.zones.some((zone) => zone.id === 'library');

  return (
    // The panel root is the sidebar's one landmark (R2). Zones are sections
    // inside it, each labelled by its own heading.
    <nav aria-label="Sidebar" className="flex min-h-0 flex-1 flex-col">
      {/* **The sidebar's whole horizontal inset, paid here and at the row.**
          Eight pixels of panel padding plus eight on every row is the 16px total
          left inset the density calls for (design-decisions §11). Nothing
          between the panel edge and the row's own padding adds anything. */}
      <SidebarContent className="sidebar-scroll-edges px-2 py-3">
        <SidebarChrome activeTarget={state.activeTarget}>
          <SidebarDnd displayNames={state.displayNames} roomTitles={roomTitles}>
            <SidebarZones model={model} />
          </SidebarDnd>
        </SidebarChrome>

        {isEmpty && (
          <AgentOnboardingCard onAddAgent={() => useAgentCreationStore.getState().open()} />
        )}

        <PromoSlot placement="dashboard-sidebar" maxUnits={3} />
      </SidebarContent>
    </nav>
  );
}
