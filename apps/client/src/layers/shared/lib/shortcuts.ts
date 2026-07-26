import { isMac } from './platform';

/** Definition of a single keyboard shortcut. */
export interface ShortcutDef {
  /** Unique identifier. */
  id: string;
  /** Key combo in a normalized format (e.g., 'mod+shift+n', '?', 'mod+k'). */
  key: string;
  /** Human-readable label (e.g., 'New session'). */
  label: string;
  /** Category for the reference panel. */
  group: ShortcutGroup;
}

/** Categories for grouping shortcuts in the reference panel. */
export type ShortcutGroup = 'sessions' | 'navigation' | 'chat' | 'global';

/** Group display order and labels. */
export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  navigation: 'Navigation',
  sessions: 'Sessions',
  chat: 'Chat',
  global: 'Global',
};

/** Display order for groups in the reference panel. */
export const SHORTCUT_GROUP_ORDER: ShortcutGroup[] = ['navigation', 'sessions', 'chat', 'global'];

/** All keyboard shortcuts in the application. Single source of truth. */
export const SHORTCUTS = {
  // Navigation
  COMMAND_PALETTE: {
    id: 'command-palette',
    key: 'mod+k',
    label: 'Command palette',
    group: 'navigation',
  },
  TOGGLE_SIDEBAR: {
    id: 'toggle-sidebar',
    key: 'mod+b',
    label: 'Toggle sidebar',
    group: 'navigation',
  },
  TOGGLE_RIGHT_PANEL: {
    id: 'toggle-right-panel',
    key: 'mod+.',
    label: 'Toggle right panel',
    group: 'navigation',
  },
  SHORTCUTS_PANEL: {
    id: 'shortcuts-panel',
    key: '?',
    label: 'Keyboard shortcuts',
    group: 'navigation',
  },
  AGENT_PROFILE: {
    id: 'agent-profile',
    key: 'mod+shift+a',
    label: 'Agent profile',
    group: 'navigation',
  },
  // In-window tabs (DOR-540). All four are registered by `useAppTabShortcuts`.
  // In the browser cockpit the browser claims these combos for its own tabs
  // before the page ever sees them, so they are live in the desktop app; the
  // strip's "+" button, its arrow-key traversal, and the command palette are
  // the surfaces that work everywhere.
  NEW_TAB: { id: 'new-tab', key: 'mod+t', label: 'New tab', group: 'navigation' },
  SELECT_TAB: { id: 'select-tab', key: 'mod+1-9', label: 'Go to tab', group: 'navigation' },
  PREVIOUS_TAB: {
    id: 'previous-tab',
    key: 'mod+shift+[',
    label: 'Previous tab',
    group: 'navigation',
  },
  NEXT_TAB: { id: 'next-tab', key: 'mod+shift+]', label: 'Next tab', group: 'navigation' },

  // Sessions
  NEW_SESSION: { id: 'new-session', key: 'mod+shift+n', label: 'New session', group: 'sessions' },

  // Chat (composer + interactive tool shortcuts)
  NEW_LINE: { id: 'new-line', key: 'shift+enter', label: 'New line', group: 'chat' },
  NEW_LINE_ALT: {
    id: 'new-line-alt',
    key: 'alt+enter',
    label: 'New line (alternate)',
    group: 'chat',
  },
  LINE_CONTINUATION: {
    id: 'line-continuation',
    key: '\\+enter',
    label: 'Keep typing on the next line',
    group: 'chat',
  },
  SESSION_DETAILS: {
    id: 'session-details',
    key: 'mod+shift+.',
    label: 'Session details',
    group: 'chat',
  },
  CLEAR_MESSAGE: { id: 'clear-message', key: 'esc esc', label: 'Clear message', group: 'chat' },
  STOP_STREAMING: {
    id: 'stop-streaming',
    key: 'esc',
    label: 'Stop generating',
    group: 'chat',
  },
  APPROVE_TOOL: { id: 'approve-tool', key: 'enter', label: 'Approve tool', group: 'chat' },
  DENY_TOOL: { id: 'deny-tool', key: 'esc', label: 'Deny tool', group: 'chat' },
  TOGGLE_OPTION: { id: 'toggle-option', key: '1-9', label: 'Toggle option', group: 'chat' },
  SUBMIT_ANSWER: { id: 'submit-answer', key: 'enter', label: 'Submit answer', group: 'chat' },

  // Global
  CLOSE_OVERLAY: { id: 'close-overlay', key: 'esc', label: 'Close overlay', group: 'global' },
  DEV_PLAYGROUND: {
    id: 'dev-playground',
    key: 'mod+shift+d',
    label: 'Dev playground',
    group: 'global',
  },
} as const satisfies Record<string, ShortcutDef>;

/**
 * Convert a normalized key string to a platform-appropriate display string.
 *
 * @param def - Shortcut definition (or just a key string)
 * @returns Display string like '\u21e7\u2318N' (Mac) or 'Ctrl+Shift+N' (Windows)
 */
export function formatShortcutKey(def: ShortcutDef | string): string {
  const key = typeof def === 'string' ? def : def.key;

  if (isMac) {
    return key
      .replace('mod+', '\u2318')
      .replace('shift+', '\u21e7')
      .replace('alt+', '\u2325')
      .replace('ctrl+', '\u2303')
      .toUpperCase();
  }

  return key
    .replace('mod+', 'Ctrl+')
    .replace('shift+', 'Shift+')
    .replace('alt+', 'Alt+')
    .toUpperCase();
}

/** Group all shortcuts by their category, in display order. */
export function getShortcutsGrouped(): {
  group: ShortcutGroup;
  label: string;
  shortcuts: ShortcutDef[];
}[] {
  const map = new Map<ShortcutGroup, ShortcutDef[]>();

  for (const shortcut of Object.values(SHORTCUTS)) {
    const list = map.get(shortcut.group) ?? [];
    list.push(shortcut);
    map.set(shortcut.group, list);
  }

  return SHORTCUT_GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
    group: g,
    label: SHORTCUT_GROUP_LABELS[g],
    shortcuts: map.get(g)!,
  }));
}
