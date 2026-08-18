import {
  Palette,
  TextCursorInput,
  Component,
  MessageSquare,
  MousePointerClick,
  Blocks,
  Play,
  Megaphone,
  Terminal,
  Network,
  Filter,
  AlertTriangle,
  Sparkles,
  Table2,
  Settings as SettingsIcon,
  ShoppingBag,
  WandSparkles,
  MapPin,
  Hash,
  Fingerprint,
  PanelLeft,
} from 'lucide-react';
import type { PlaygroundSection } from './playground-registry';
import {
  PLAYGROUND_REGISTRY,
  TOKENS_SECTIONS,
  FORMS_SECTIONS,
  COMPONENTS_SECTIONS,
  CONVERSATION_SECTIONS,
  ENTRY_ACTIONS_SECTIONS,
  FEATURES_SECTIONS,
  IDENTITY_SECTIONS,
  PROMOS_SECTIONS,
  COMMAND_PALETTE_SECTIONS,
  SIMULATOR_SECTIONS,
  TOPOLOGY_SECTIONS,
  FILTER_BAR_SECTIONS,
  ERROR_STATES_SECTIONS,
  ONBOARDING_SECTIONS,
  TABLES_SECTIONS,
  SETTINGS_SECTIONS,
  MARKETPLACE_SECTIONS,
  GEN_UI_SECTIONS,
  ROOMS_SECTIONS,
  TOUR_SPOTLIGHT_SECTIONS,
  SIDEBAR_MODEL_SECTIONS,
} from './playground-registry';

/** Navigation group a page belongs to in the sidebar. */
export type PageGroup = 'design-system' | 'gen-ui' | 'session' | 'agents' | 'app-shell';

/** Centralized metadata for a single playground page. */
export interface PageConfig {
  /** Unique page identifier — matches the `Page` type union. */
  id: string;
  /** Human-readable label for sidebar nav, search headings, and overview cards. */
  label: string;
  /** Short description shown in page headers and overview cards. */
  description: string;
  /** Lucide icon component for sidebar nav and overview cards. */
  icon: React.ComponentType<{ className?: string }>;
  /** Sidebar navigation group. */
  group: PageGroup;
  /** Section registry entries for this page (drives TOC and Cmd+K search). */
  sections: PlaygroundSection[];
  /** URL path segment (e.g. `'tokens'` → `/dev/tokens`). */
  path: string;
}

/**
 * Sections another page owns that the Identity page also renders, in the order
 * it renders them (spec `identity-consistency` §W4.2).
 *
 * A title holds exactly one registry entry — the registry forbids duplicate ids
 * and pins `id === slugify(title)` — so a section cannot be registered twice to
 * appear on two pages. Cross-listing is done by RENDERING the same showcase
 * component from both pages and borrowing its entry for this page's TOC. The
 * accepted cost: these sections still group under their own page in ⌘K, and
 * their canonical anchor stays where it was. That is the trade for not breaking
 * a single existing `/dev/components#…`, `/dev/rooms#…` or `/dev/conversation#…`
 * link. (The one path this programme did retire, `/dev/chat`, keeps working
 * through {@link PATH_ALIASES} rather than falling through to Overview.)
 */
export const IDENTITY_CROSS_LISTED: readonly string[] = [
  'identityavatar',
  'mentionpill',
  'identityhovercard',
  'a-mention-in-a-real-message',
  'messageauthoravatar',
  'agentidentitychip',
  'roomavatar',
  'roommemberrow',
];

/**
 * The one section Subsystems owns that the Conversation page also renders
 * (DOR-1332, P5). Same shape as {@link IDENTITY_CROSS_LISTED}: the
 * capability-approval card (`ApprovalCard`) answers "may this agent do X at
 * all", a different question from the Ask card family the Asks section holds,
 * but a reader of that section still wants it beside the rest of the family.
 * Its registry entry — and its canonical `/dev/features#approvalcard` anchor —
 * stays on Subsystems; Conversation borrows it by rendering, never by
 * registering it a second time.
 */
export const CONVERSATION_CROSS_LISTED: readonly string[] = ['approvalcard'];

/**
 * Look up borrowed sections by id, in the order given.
 *
 * Throws rather than skipping a miss: a silently dropped id is a section that
 * renders on the page with no way to reach it from the TOC, which is the exact
 * drift the registry test exists to catch. The test imports this module, so a
 * renamed section fails there rather than only in a browser nobody opened.
 */
function crossListed(ids: readonly string[]): PlaygroundSection[] {
  return ids.map((id) => {
    const section = PLAYGROUND_REGISTRY.find((entry) => entry.id === id);
    if (section === undefined) {
      throw new Error(
        `Cross-listed playground section "${id}" is not in PLAYGROUND_REGISTRY — it was renamed or removed.`
      );
    }
    return section;
  });
}

/**
 * Single source of truth for all playground pages.
 *
 * Adding a new page is a one-line addition here — nav, search, overview,
 * and route parsing all derive from this array.
 */
export const PAGE_CONFIGS: PageConfig[] = [
  // ── Design System ──
  {
    id: 'tokens',
    label: 'Design Tokens',
    description:
      'Color palette, typography, spacing, border radius, and shadow tokens that define the visual language.',
    icon: Palette,
    group: 'design-system',
    sections: TOKENS_SECTIONS,
    path: 'tokens',
  },
  {
    id: 'forms',
    label: 'Forms',
    description:
      'Form primitives and composed input components — inputs, selects, comboboxes, and tag inputs.',
    icon: TextCursorInput,
    group: 'design-system',
    sections: FORMS_SECTIONS,
    path: 'forms',
  },
  {
    id: 'components',
    label: 'Components',
    description:
      'Interactive gallery of shared UI primitives — buttons, overlays, navigation, and feedback.',
    icon: Component,
    group: 'design-system',
    sections: COMPONENTS_SECTIONS,
    path: 'components',
  },
  // ── Generative UI ──
  {
    id: 'gen-ui',
    label: 'Widgets',
    description:
      'Agent-authored widgets rendered from dorkos-ui fences — loading state, stat cards, tables, charts, lists, and error fallback.',
    icon: WandSparkles,
    group: 'gen-ui',
    sections: GEN_UI_SECTIONS,
    path: 'gen-ui',
  },
  {
    id: 'tour-spotlight',
    label: 'Tour Spotlight',
    description: 'The DorkBot living-tour spotlight primitive over @reactour/tour (DOR-419 spike).',
    icon: MapPin,
    group: 'app-shell',
    sections: TOUR_SPOTLIGHT_SECTIONS,
    path: 'tour-spotlight',
  },
  // ── Session ──
  {
    id: 'conversation',
    label: 'Conversation',
    description:
      'The Conversation compound every messaging surface composes — session, room and DM side by side from one fixture, the Message.* row matrix, the timeline, the live lane and its Asks, and the composer against both targets.',
    icon: MessageSquare,
    group: 'session',
    // Owned sections first, then the one this page renders but Subsystems
    // owns — see CONVERSATION_CROSS_LISTED for why cross-listing works this
    // way.
    sections: [...CONVERSATION_SECTIONS, ...crossListed(CONVERSATION_CROSS_LISTED)],
    path: 'conversation',
  },
  {
    id: 'entry-actions',
    label: 'Entry Actions',
    description:
      'The action surface every room message carries — where the capsule sits, how it arrives, its sticky rail, and how the pill holds its buttons across action counts, group positions, and both themes.',
    icon: MousePointerClick,
    group: 'session',
    sections: ENTRY_ACTIONS_SECTIONS,
    path: 'entry-actions',
  },
  {
    id: 'simulator',
    label: 'Simulator',
    description: 'Chat message streaming simulator with scripted playback scenarios.',
    icon: Play,
    group: 'session',
    sections: SIMULATOR_SECTIONS,
    path: 'simulator',
  },
  // ── Agents ──
  {
    id: 'identity',
    label: 'Identity',
    description:
      'Every face DorkOS draws, in one place — the disc, the mention, the card, the roster, the profile — so the whole identity language can be reviewed at once.',
    icon: Fingerprint,
    group: 'agents',
    // Owned sections first, then the ones this page renders but another page
    // owns — see IDENTITY_CROSS_LISTED for why cross-listing works this way.
    sections: [...IDENTITY_SECTIONS, ...crossListed(IDENTITY_CROSS_LISTED)],
    path: 'identity',
  },
  {
    id: 'features',
    label: 'Subsystems',
    description: 'Domain-specific components from Relay, Mesh, and Tasks features.',
    icon: Blocks,
    group: 'agents',
    sections: FEATURES_SECTIONS,
    path: 'features',
  },
  {
    id: 'topology',
    label: 'Topology',
    description:
      'React Flow custom nodes, edges, and chrome used in the agent mesh topology graph.',
    icon: Network,
    group: 'agents',
    sections: TOPOLOGY_SECTIONS,
    path: 'topology',
  },
  // ── App Shell ──
  {
    id: 'command-palette',
    label: 'Command Palette',
    description: 'Agent items, search highlighting, sub-menus, keyboard hints, and edge cases.',
    icon: Terminal,
    group: 'app-shell',
    sections: COMMAND_PALETTE_SECTIONS,
    path: 'command-palette',
  },
  {
    id: 'filter-bar',
    label: 'Filter Bar',
    description:
      'Composable filter system with text search, enum, date range, sort, and responsive active filters.',
    icon: Filter,
    group: 'app-shell',
    sections: FILTER_BAR_SECTIONS,
    path: 'filter-bar',
  },
  {
    id: 'onboarding',
    label: 'Onboarding',
    description:
      'Full interactive onboarding flow, individual step previews, and supporting components.',
    icon: Sparkles,
    group: 'app-shell',
    sections: ONBOARDING_SECTIONS,
    path: 'onboarding',
  },
  {
    id: 'error-states',
    label: 'Error States',
    description: 'Error boundaries, 404 pages, crash fallbacks, and toast notifications.',
    icon: AlertTriangle,
    group: 'app-shell',
    sections: ERROR_STATES_SECTIONS,
    path: 'error-states',
  },
  {
    id: 'promos',
    label: 'Feature Promos',
    description: 'Promo registry, slot previews, override controls, and dialog previews.',
    icon: Megaphone,
    group: 'app-shell',
    sections: PROMOS_SECTIONS,
    path: 'promos',
  },
  // ── Design System (continued) ──
  {
    id: 'tables',
    label: 'Tables',
    description:
      'Table primitives and data tables — sorting, selection, empty states, and domain-specific examples.',
    icon: Table2,
    group: 'design-system',
    sections: TABLES_SECTIONS,
    path: 'tables',
  },
  {
    id: 'settings',
    label: 'Settings',
    description:
      'Settings dialogs, individual tabs, mobile drill-in, loading and empty states, and the underlying primitives.',
    icon: SettingsIcon,
    group: 'app-shell',
    sections: SETTINGS_SECTIONS,
    path: 'settings',
  },
  {
    id: 'rooms',
    label: 'Rooms',
    description:
      'The room sheet and everything in it — roster rows, the loudness scale and its meter, the agent picker, and the removal confirmation.',
    icon: Hash,
    group: 'agents',
    sections: ROOMS_SECTIONS,
    path: 'rooms',
  },
  // ── Marketplace ──
  {
    id: 'marketplace',
    label: 'Marketplace',
    description:
      'Marketplace browse grid, package cards, install flows, permission previews, and source management.',
    icon: ShoppingBag,
    group: 'agents',
    sections: MARKETPLACE_SECTIONS,
    path: 'marketplace',
  },
  // ── App Shell (continued) ──
  //
  // Appended at the very end deliberately. This array is edited by several
  // tasks at once during the sidebar redesign; a new page goes on the end and
  // an edit to an existing page goes where that page already is, so two
  // branches never touch the same lines.
  {
    id: 'sidebar-model',
    label: 'Sidebar Model',
    description:
      'buildSidebarModel over its four journey fixtures — every zone, section and row, each carrying the reason it is there.',
    icon: PanelLeft,
    group: 'app-shell',
    sections: SIDEBAR_MODEL_SECTIONS,
    path: 'sidebar-model',
  },
];

// ── Derived lookups ──

/** Human-readable label for each page, keyed by page ID. */
export const PAGE_LABELS: Record<string, string> = Object.fromEntries(
  PAGE_CONFIGS.map((c) => [c.id, c.label])
);

/** Ordered list of page IDs for consistent rendering (e.g. search groups). */
export const PAGE_ORDER: string[] = PAGE_CONFIGS.map((c) => c.id);

/** Pages in the "Design System" sidebar group. */
export const DESIGN_SYSTEM_NAV = PAGE_CONFIGS.filter((c) => c.group === 'design-system');

/** Pages in the "Generative UI" sidebar group. */
export const GEN_UI_NAV = PAGE_CONFIGS.filter((c) => c.group === 'gen-ui');

/** Pages in the "Session" sidebar group. */
export const SESSION_NAV = PAGE_CONFIGS.filter((c) => c.group === 'session');

/** Pages in the "Agents" sidebar group. */
export const AGENTS_NAV = PAGE_CONFIGS.filter((c) => c.group === 'agents');

/** Pages in the "App Shell" sidebar group. */
export const APP_SHELL_NAV = PAGE_CONFIGS.filter((c) => c.group === 'app-shell');

/**
 * Retired paths, and the page that answers them now.
 *
 * A path that no longer exists falls back to Overview with the URL unchanged —
 * no redirect, no notice — so a bookmark to a renamed page silently lands
 * somewhere else and takes its `#anchor` with it. One entry per rename is
 * cheaper than that. `/dev/chat` became `/dev/conversation` in DOR-1332 (P5).
 */
const PATH_ALIASES: Readonly<Record<string, string>> = { chat: 'conversation' };

/**
 * Resolve the current page from the URL pathname.
 *
 * Checks the live `path` of every page first, then {@link PATH_ALIASES} for a
 * path a rename retired. Falls back to `'overview'` for anything else.
 */
export function getPageFromPath(pathname: string): string {
  const match = PAGE_CONFIGS.find((c) => pathname.startsWith(`/dev/${c.path}`));
  if (match) return match.id;
  const alias = Object.keys(PATH_ALIASES).find((path) => pathname.startsWith(`/dev/${path}`));
  return alias === undefined ? 'overview' : PATH_ALIASES[alias]!;
}
