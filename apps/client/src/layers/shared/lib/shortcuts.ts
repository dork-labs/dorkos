import { isMac, isDesktopShell } from './platform';

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
  /**
   * Live only in the desktop app, and so listed only there
   * ({@link getShortcutsGrouped}).
   *
   * The reference panel is a promise: a combo it lists must do something when
   * you press it. A panel that advertises keys the browser has already taken is
   * worse than one that leaves them out, because the reader blames DorkOS for
   * not working. Mark the shortcut, do not fork the panel.
   */
  desktopOnly?: boolean;
  /**
   * Live only in a development build, and so listed only there
   * ({@link getShortcutsGrouped}).
   *
   * Same reasoning as {@link desktopOnly}, for the other axis: a chord whose
   * handler is gated on `import.meta.env.DEV` does nothing once that flag is
   * false, so a production reader who presses it gets silence DorkOS
   * promised would do something (DOR-567). Mark the shortcut, do not fork
   * the panel.
   */
  devOnly?: boolean;
}

/** Categories for grouping shortcuts in the reference panel. */
export type ShortcutGroup = 'navigation' | 'chat' | 'global';

/** Group display order and labels. */
export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  navigation: 'Navigation',
  chat: 'Chat',
  global: 'Global',
};

/** Display order for groups in the reference panel. */
export const SHORTCUT_GROUP_ORDER: ShortcutGroup[] = ['navigation', 'chat', 'global'];

/** All keyboard shortcuts in the application. Single source of truth. */
export const SHORTCUTS = {
  // Navigation
  COMMAND_PALETTE: {
    id: 'command-palette',
    key: 'mod+k',
    label: 'Command palette',
    group: 'navigation',
  },
  // The New menu's fast path (spec `sidebar-now-today-library` BC-45). Desktop
  // only, and listed only there, for the reason `desktopOnly` exists: a browser
  // claims Cmd/Ctrl+N for its own new window before the page ever sees the
  // event, so advertising it in a browser would promise something DorkOS cannot
  // deliver.
  NEW_SESSION: {
    id: 'new-session',
    key: 'mod+n',
    label: 'New session',
    group: 'navigation',
    desktopOnly: true,
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
    label: 'Profile',
    group: 'navigation',
  },
  // The Control Center flyout — see and change the fleet's power at a glance
  // (spec `full-power-defaults`, D7). NOT `mod+shift+p`: Firefox reserves that
  // for its private window, so it never reaches the page. `mod+shift+l` is free
  // in this registry and unbound in Chrome, Firefox and Safari.
  CONTROL_CENTER: {
    id: 'control-center',
    key: 'mod+shift+l',
    label: 'Control Center',
    group: 'navigation',
  },
  // In-window tabs (DOR-540), registered by `useAppTabShortcuts` — in the
  // desktop app and nowhere else (DOR-568). The tabs they drive are a desktop
  // feature: a browser owns its own tabs, and these keys already address them
  // there. So the panel does not list them in a browser.
  NEW_TAB: {
    id: 'new-tab',
    key: 'mod+t',
    label: 'New tab',
    group: 'navigation',
    desktopOnly: true,
  },
  SELECT_TAB: {
    id: 'select-tab',
    key: 'mod+1-9',
    label: 'Go to tab',
    group: 'navigation',
    desktopOnly: true,
  },
  PREVIOUS_TAB: {
    id: 'previous-tab',
    key: 'mod+shift+[',
    label: 'Previous tab',
    group: 'navigation',
    desktopOnly: true,
  },
  NEXT_TAB: {
    id: 'next-tab',
    key: 'mod+shift+]',
    label: 'Next tab',
    group: 'navigation',
    desktopOnly: true,
  },

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
  // Its own chord, and NOT `mod+shift+a`: that one has opened the Profile since
  // that panel shipped, and a key whose meaning depends on whether something
  // happens to be waiting is a promise the `?` panel cannot make — it would have
  // to list one combo with two labels, and a reader who pressed it would learn
  // which one they got by watching the screen. `y` for "yes / your answer",
  // verified free in this registry and unbound in Chrome, Firefox and Safari.
  ANSWER_NEXT_ASK: {
    id: 'answer-next-ask',
    key: 'mod+shift+y',
    label: 'Answer the next thing waiting on you',
    group: 'chat',
  },

  // Global
  CLOSE_OVERLAY: { id: 'close-overlay', key: 'esc', label: 'Close overlay', group: 'global' },
  DEV_PLAYGROUND: {
    id: 'dev-playground',
    key: 'mod+shift+d',
    label: 'Dev playground',
    group: 'global',
    devOnly: true,
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

/**
 * The shortcuts this surface actually has, grouped by category in display
 * order — what the reference panel renders.
 *
 * {@link ShortcutDef.desktopOnly} entries are dropped outside the desktop app,
 * so the panel never advertises a key the browser has already claimed.
 * {@link ShortcutDef.devOnly} entries are dropped outside a development build,
 * for the same reason on the other axis. Read at call time, not at module
 * load, so it reflects the surface rather than the import order.
 */
export function getShortcutsGrouped(): {
  group: ShortcutGroup;
  label: string;
  shortcuts: ShortcutDef[];
}[] {
  const map = new Map<ShortcutGroup, ShortcutDef[]>();
  const desktop = isDesktopShell();
  // Annotated to widen `SHORTCUTS`'s literal members back to `ShortcutDef`:
  // `as const` drops the optional keys an entry does not set.
  const all: ShortcutDef[] = Object.values(SHORTCUTS);

  for (const shortcut of all) {
    if (shortcut.desktopOnly && !desktop) continue;
    if (shortcut.devOnly && !import.meta.env.DEV) continue;
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
