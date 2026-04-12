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
  /** Where the shortcut is active. Defaults to 'global'. */
  scope?: 'global' | 'sidebar';
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
  TOGGLE_CANVAS: {
    id: 'toggle-canvas',
    key: 'mod+.',
    label: 'Toggle canvas',
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

  // Sessions
  NEW_SESSION: { id: 'new-session', key: 'mod+shift+n', label: 'New session', group: 'sessions' },
  TAB_SESSIONS: {
    id: 'tab-sessions',
    key: 'mod+1',
    label: 'Sessions tab',
    group: 'sessions',
    scope: 'sidebar',
  },
  TAB_SCHEDULES: {
    id: 'tab-schedules',
    key: 'mod+2',
    label: 'Schedules tab',
    group: 'sessions',
    scope: 'sidebar',
  },
  TAB_CONNECTIONS: {
    id: 'tab-connections',
    key: 'mod+3',
    label: 'Connections tab',
    group: 'sessions',
    scope: 'sidebar',
  },

  // Chat (interactive tool shortcuts)
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
