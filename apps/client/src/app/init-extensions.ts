import { lazy } from 'react';
import { Activity, FolderTree, PanelRight, Puzzle, SquareTerminal, User } from 'lucide-react';
import { useExtensionRegistry } from '@/layers/shared/model';
import { getPlatform } from '@/layers/shared/lib';

/** The extension registry's `register` action (idempotent per slot + id). */
type RegisterFn = ReturnType<typeof useExtensionRegistry.getState>['register'];
import {
  PALETTE_FEATURES,
  PALETTE_QUICK_ACTIONS,
  PALETTE_DEV_ACTIONS,
} from '@/layers/features/command-palette';
import { SIDEBAR_FOOTER_BUTTONS } from '@/layers/features/session-list';
import { DASHBOARD_SECTION_CONTRIBUTIONS } from '@/layers/widgets/dashboard';
import { DIALOG_CONTRIBUTIONS } from '@/layers/widgets/app-layout';

/**
 * Register all built-in features into the extension registry.
 * Called once at app startup, before React renders.
 */
export function initializeExtensions(): void {
  const { register } = useExtensionRegistry.getState();

  // Command palette items (priority 1-10 for built-ins). Some built-ins depend
  // on AppShell chrome the Obsidian embed never renders, so acting on them there
  // is a dead-end: Create Agent / "Bring in existing projects" open dialogs
  // (CreateAgentDialog / ImportProjectsDialog) that mount only in AppShell;
  // Agent Profile and Canvas open the right panel the embed never renders; and
  // Dashboard / Agents call navigate(), which throws with no RouterProvider (the
  // pattern documented in chat/model/status/use-runtime-chip.ts). Skip them under
  // the embed.
  //
  // NOTE: this is a DEFENSIVE gate, not a live fix — the embed does not currently
  // call initializeExtensions at all (only the web entry, apps/client/src/main.tsx,
  // does), so no built-in palette action is registered there today. The gate keeps
  // these dead-ends out of the embed's palette if/when it ever registers built-ins.
  const embedded = getPlatform().isEmbedded;
  const embeddedDeadEndActions = new Set([
    'createAgent',
    'discoverAgents',
    'openAgentProfile',
    'toggleCanvas',
    'navigateDashboard',
    'openMesh',
  ]);
  const skipUnderEmbed = (action: string) => embedded && embeddedDeadEndActions.has(action);
  for (const feature of PALETTE_FEATURES) {
    if (skipUnderEmbed(feature.action)) continue;
    register('command-palette.items', feature);
  }
  for (const action of PALETTE_QUICK_ACTIONS) {
    if (skipUnderEmbed(action.action)) continue;
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

  // Dashboard sections
  for (const section of DASHBOARD_SECTION_CONTRIBUTIONS) {
    register('dashboard.sections', section);
  }

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

  // Extensions settings tab (lazy-loaded to avoid bloating the initial bundle)
  register('settings.tabs', {
    id: 'extensions',
    label: 'Extensions',
    icon: Puzzle,
    component: lazy(() =>
      import('@/layers/features/extensions').then((m) => ({ default: m.ExtensionsSettingsTab }))
    ),
    priority: 70,
  });

  // Right-panel inspector tabs — shared by every shell (the routed cockpit and
  // the Obsidian embed), so the Inspector is one architecture everywhere.
  registerRightPanelTabs(register);
}

/**
 * Register the built-in right-panel (Inspector) tabs into the extension
 * registry. Called from both the web entry ({@link initializeExtensions}) and
 * the Obsidian embed so the Inspector is identical across shells — route- and
 * transport-gating (not a divergent tab list) decides what shows where. The
 * registry dedupes by id, so calling this more than once is safe.
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
  // so /session still opens to Agent Profile (honoring DOR-227) while
  // dashboard/activity/tasks/… open to Pulse. Its body promotes global content
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

  // Agent Hub as right-panel contribution (lazy-loaded).
  //
  // Visibility is selection-honest, so the Agent Profile never shows an agent the
  // operator did not choose:
  //   • /marketplace* → hidden. There is no agent context to profile there.
  //   • /session       → shown. The panel profiles the session's own agent.
  //   • anywhere else  → shown ONLY once the operator has explicitly opened an
  //                      agent this session (openHub sets `explicitAgentPath`).
  // Without the last rule the tab would surface the ambient startup agent — the
  // server's default cwd, which nobody picked — and often render a misleading
  // "Agent not found" (see AGENTS.md, the "describe what happens for the user"
  // filter). `explicitAgentPath` is the click-driven signal; `cwd`/`agentId` are
  // ambient and deliberately not used to gate this tab. In the embed the constant
  // `/session` pathname keeps the panel on the session's own agent.
  register('right-panel', {
    id: 'agent-hub',
    title: 'Agent Profile',
    icon: User,
    component: lazy(() =>
      import('@/layers/features/agent-hub').then((m) => ({ default: m.AgentHub }))
    ),
    visibleWhen: ({ pathname, explicitAgentPath }) => {
      if (pathname.startsWith('/marketplace')) return false;
      if (pathname === '/session') return true;
      return explicitAgentPath != null;
    },
    priority: 10,
  });

  // File explorer as right-panel contribution (lazy-loaded — the tree + CRUD UI
  // lands in its own async chunk). Session-scoped like the canvas: the tree is
  // rooted at the session's working directory. Works under both transports
  // (DirectTransport implements the file-service methods), so it is NOT gated on
  // a web-only capability — only on the /session route.
  register('right-panel', {
    id: 'files',
    title: 'Files',
    icon: FolderTree,
    component: lazy(() =>
      import('@/layers/features/file-explorer').then((m) => ({ default: m.FileExplorer }))
    ),
    // Toolbar (New File / New Folder / Show hidden / Refresh) rendered in the
    // container-owned panel header, wired to the tree via the file-explorer store.
    headerActions: lazy(() =>
      import('@/layers/features/file-explorer').then((m) => ({ default: m.FileExplorerActions }))
    ),
    visibleWhen: ({ pathname }) => pathname === '/session',
    priority: 15,
  });

  // Canvas as right-panel contribution (lazy-loaded, only visible on /session)
  register('right-panel', {
    id: 'canvas',
    title: 'Canvas',
    icon: PanelRight,
    component: lazy(() =>
      import('@/layers/features/canvas').then((m) => ({ default: m.CanvasContent }))
    ),
    visibleWhen: ({ pathname }) => pathname === '/session',
    priority: 20,
  });

  // Terminal as right-panel contribution (lazy-loaded — @xterm/* lands in its
  // own async chunk). Web-only: shown on /session AND only when the active
  // transport supports a server-side PTY (hidden under the in-process Obsidian
  // transport, D3). This is the capability gate the embed relies on to drop the
  // terminal tab automatically — the tab list is identical across shells.
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
