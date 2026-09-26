import { lazy } from 'react';
import {
  Activity,
  FolderTree,
  Gauge,
  Globe,
  PanelRight,
  Puzzle,
  SquareTerminal,
  User,
  Users,
} from 'lucide-react';
import { useExtensionRegistry } from '@/layers/shared/model';

/** The extension registry's `register` action (idempotent per slot + id). */
type RegisterFn = ReturnType<typeof useExtensionRegistry.getState>['register'];
import {
  PALETTE_FEATURES,
  PALETTE_QUICK_ACTIONS,
  PALETTE_DEV_ACTIONS,
} from '@/layers/features/command-palette';
import { SIDEBAR_FOOTER_BUTTONS } from '@/layers/features/session-list';
import { PROFILE_PANEL_ID } from '@/layers/features/profile';
import { ROOM_PANEL_ID } from '@/layers/features/room-management';
import { routeShowsRoom } from '@/layers/entities/room';
import { DIALOG_CONTRIBUTIONS } from '@/layers/widgets/app-layout';

/**
 * Register all built-in features into the extension registry.
 * Called once at app startup, before React renders.
 */
export function initializeExtensions(): void {
  const { register } = useExtensionRegistry.getState();

  // Register the built-in command palette items.
  for (const feature of PALETTE_FEATURES) {
    register('command-palette.items', feature);
  }
  for (const action of PALETTE_QUICK_ACTIONS) {
    register('command-palette.items', action);
  }

  // Dev-only command palette items
  if (import.meta.env.DEV) {
    for (const action of PALETTE_DEV_ACTIONS) {
      register('command-palette.items', action);
    }
  }

  // Sidebar footer buttons
  for (const button of SIDEBAR_FOOTER_BUTTONS) {
    register('sidebar.footer', button);
  }

  // No built-in `dashboard.sections` contributions: the four that existed were
  // retired with the dashboard itself (team-room-home spec D3.5) — the composer
  // became the #team room's, approvals and attention moved into the home tab's
  // pinned triage header, and the activity preview became the Activity tab. The
  // SLOT stays: extensions in the wild still contribute to it, and the Activity
  // tab draws their sections (`widgets/activity/ui/ExtensionSections.tsx`).

  // Marketplace sidebar takeover (lazy-loaded). The `sidebar.body` slot is
  // FIRST-PARTY ONLY in v1: it is registered here, from client init, and is
  // deliberately absent from `ExtensionPointId` in `@dorkos/extension-api`, so
  // `api.registerComponent` cannot target it. Replacing the whole sidebar body
  // is a high-trust surface; opening it to third-party extensions is a future
  // product decision, not an oversight. This body takes over on `/marketplace`
  // paths, swapping the agent roster for the type + category filter facets.
  register('sidebar.body', {
    id: 'marketplace-facets',
    component: lazy(() =>
      import('@/layers/features/marketplace').then((m) => ({ default: m.MarketplaceSidebar }))
    ),
    visibleWhen: ({ pathname }) => pathname.startsWith('/marketplace'),
    priority: 10,
  });

  // Dialog contributions
  for (const dialog of DIALOG_CONTRIBUTIONS) {
    register('dialog', dialog);
  }

  // The living tour's in-session offer chip (DOR-419). The chat feature renders
  // the `chat.suggestion-chips` slot; the tours feature contributes into it here
  // (app layer), so neither feature imports the other's model. Self-gating: it
  // renders null until an occasion stands.
  register('chat.suggestion-chips', {
    id: 'tour-offer',
    component: lazy(() =>
      import('@/layers/features/tours').then((m) => ({ default: m.TourOfferChips }))
    ),
    priority: 10,
  });

  // Extensions settings tab (lazy-loaded to avoid bloating the initial bundle)
  register('settings.tabs', {
    id: 'extensions',
    label: 'Extensions',
    icon: Puzzle,
    component: lazy(() =>
      import('@/layers/features/extensions').then((m) => ({ default: m.ExtensionsSettingsTab }))
    ),
    priority: 70,
    group: 'Add-ons',
  });

  registerRightPanelTabs(register);
}

/**
 * Register the app’s route-aware Inspector tabs.
 *
 * @param register - The extension registry's `register` action.
 */
export function registerRightPanelTabs(register: RegisterFn): void {
  // Pulse — the always-present GLOBAL spine tab of the right panel (lazy-loaded).
  //
  // It carries no `visibleWhen`, so it shows on every route, and priority 5 (below
  // every contextual tab) sorts it first in the strip. It is the panel's
  // no-selection fallback: `isGlobal` tells the container's auto-select to prefer
  // a contextual tab when one is visible and only land on Pulse when none is — the
  // Chrome sidePanel rule (contextual wins when present, global is the fallback),
  // so /session still opens to Profile (honoring DOR-227) while
  // home/activity/tasks/… open to Pulse. Its body promotes global content
  // (attention + activity teasers) into the panel so the shell is never dead.
  //
  // Strip order rests purely on this priority-5 convention — `isGlobal` gates the
  // default-tab choice, never the sort. Keeping Pulse leftmost is deliberate: a
  // future contextual tab registered with priority < 5 would sort ahead of it, so
  // hold new contextual tabs at priority ≥ 10 (the current floor) to preserve it.
  register('right-panel', {
    id: 'pulse',
    title: 'Pulse',
    icon: Activity,
    isGlobal: true,
    component: lazy(() =>
      import('@/layers/widgets/pulse').then((m) => ({ default: m.PulsePanel }))
    ),
    priority: 5,
  });

  // Room management as a right-panel contribution (lazy-loaded) — the roster,
  // the topic, and how loud each agent is, beside the room they belong to (spec
  // `one-bar-header` §3.6). It replaces the modal room sheet: every door that
  // used to raise one now calls `openRoomPanel`.
  //
  // Visible on the two routes that show a room, and contextual, so the
  // container's auto-select opens straight onto it there while Pulse stays one
  // press away in the strip.
  //
  // **Priority 8, below Profile's 10 and above Pulse's 5.** Auto-select takes
  // the first contextual tab in strip order, and Profile is visible off
  // `/session` as soon as anybody has opened one this session — so at 10 or more
  // this tab would lose the room routes to a profile the reader opened an hour
  // ago. Pulse is still leftmost, which is the only thing the ≥10 convention
  // recorded in this file was protecting.
  register('right-panel', {
    id: ROOM_PANEL_ID,
    title: 'Room',
    icon: Users,
    component: lazy(() =>
      import('@/layers/features/room-management').then((m) => ({ default: m.RoomPanel }))
    ),
    visibleWhen: ({ pathname, isRemoteCommunityRoom }) =>
      routeShowsRoom(pathname) && !isRemoteCommunityRoom,
    priority: 8,
  });

  register('right-panel', {
    id: PROFILE_PANEL_ID,
    title: 'Profile',
    icon: User,
    component: lazy(() =>
      import('@/layers/features/profile').then((m) => ({ default: m.ProfileDock }))
    ),
    visibleWhen: ({ pathname, explicitAgentPath }) => {
      if (pathname.startsWith('/marketplace')) return false;
      if (pathname === '/session') return true;
      return explicitAgentPath != null;
    },
    priority: 10,
  });

  register('right-panel', {
    id: 'session',
    title: 'Session',
    icon: Gauge,
    component: lazy(() =>
      import('@/layers/features/status').then((m) => ({ default: m.SessionInspector }))
    ),
    visibleWhen: ({ pathname }) => pathname === '/session',
    priority: 12,
  });

  register('right-panel', {
    id: 'files',
    title: 'Files',
    icon: FolderTree,
    component: lazy(() =>
      import('@/layers/features/file-explorer').then((m) => ({ default: m.FileExplorer }))
    ),
    // Toolbar (New file / New folder / Show hidden / Refresh) rendered in the
    // container-owned panel header, wired to the tree via the file-explorer store.
    headerActions: lazy(() =>
      import('@/layers/features/file-explorer').then((m) => ({ default: m.FileExplorerActions }))
    ),
    visibleWhen: ({ pathname }) => pathname === '/session',
    priority: 15,
  });

  // Canvas as right-panel contribution (lazy-loaded). It holds every document the
  // false browser does NOT render; pages live one tab along, in Browser
  // (ADR 260911-200304).
  //
  // On `/session` it is that session's own canvas, private to this browser. On a
  // room route it is the ROOM's shared table, live off the room's stream and the
  // same for every member (spec `room-canvas` §9). Same tab, same strip, same
  // viewers — what changes is who owns the documents.
  //
  // Room (priority 8) still wins the panel's auto-select on a room route, and
  // that is deliberate: a tab that selected itself when another member put
  // something on the table would be the pixel version of a turn that triggers
  // itself. An arrival lights the unread dot here and moves nothing.
  register('right-panel', {
    id: 'canvas',
    title: 'Canvas',
    icon: PanelRight,
    component: lazy(() =>
      import('@/layers/features/canvas').then((m) => ({ default: m.CanvasContent }))
    ),
    visibleWhen: ({ pathname }) => pathname === '/session' || routeShowsRoom(pathname),
    priority: 20,
  });

  register('right-panel', {
    id: 'browser',
    title: 'Browser',
    icon: Globe,
    component: lazy(() =>
      import('@/layers/features/canvas').then((m) => ({ default: m.BrowserContent }))
    ),
    visibleWhen: ({ pathname, transport }) =>
      (pathname === '/session' || routeShowsRoom(pathname)) &&
      transport?.supportsWorkbenchServe === true,
    priority: 22,
  });

  register('right-panel', {
    id: 'terminal',
    title: 'Terminal',
    icon: SquareTerminal,
    component: lazy(() =>
      import('@/layers/features/terminal').then((m) => ({ default: m.TerminalPanel }))
    ),
    visibleWhen: ({ pathname, transport }) =>
      pathname === '/session' && transport?.supportsTerminal === true,
    priority: 25,
  });
}
