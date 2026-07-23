import type { LucideIcon } from 'lucide-react';
import {
  FolderOpen,
  GitBranch,
  Bot,
  Cpu,
  BarChart3,
  Zap,
  Gauge,
  Shield,
  Volume2,
  RefreshCw,
} from 'lucide-react';
import { useCallback } from 'react';
import { useStatusBarPrefs, useUpdateStatusBarPrefs } from '@/layers/entities/config';

/** Union of all toggleable status bar item keys. */
export type StatusBarItemKey =
  | 'cwd'
  | 'git'
  | 'runtime'
  | 'model'
  | 'cache'
  | 'context'
  | 'usage'
  | 'permission'
  | 'sound'
  | 'polling';

/** Grouping categories for the configure popover section headers. */
export type StatusBarItemGroup = 'session' | 'controls';

export interface StatusBarItemConfig {
  /** Unique key matching the `ui.statusBar` config field name (e.g., 'cwd'). */
  key: StatusBarItemKey;
  /** Human-readable label shown in the popover and right-click menu. */
  label: string;
  /** Short description shown as subtitle in the popover. */
  description: string;
  /** Grouping category for popover section headers. */
  group: StatusBarItemGroup;
  /** Lucide icon component for the popover row. */
  icon: LucideIcon;
  /** Default visibility state, used by the scoped reset function. */
  defaultVisible: boolean;
}

/** Human-readable labels for each group, used as section headers. */
export const GROUP_LABELS: Record<StatusBarItemGroup, string> = {
  session: 'Session Info',
  controls: 'Controls',
};

/**
 * Ordered registry of all user-toggleable status bar items.
 * Items not in this registry (connection, clients) are system-managed.
 */
export const STATUS_BAR_REGISTRY: readonly StatusBarItemConfig[] = [
  {
    key: 'cwd',
    label: 'Directory',
    description: 'Current working directory',
    group: 'session',
    icon: FolderOpen,
    defaultVisible: true,
  },
  {
    key: 'git',
    label: 'Git Status',
    description: 'Branch name and change count',
    group: 'session',
    icon: GitBranch,
    defaultVisible: true,
  },
  {
    key: 'runtime',
    label: 'Runtime',
    description: 'Agent runtime for this session',
    group: 'session',
    icon: Cpu,
    defaultVisible: true,
  },
  {
    key: 'model',
    label: 'Model',
    description: 'Selected AI model',
    group: 'session',
    icon: Bot,
    defaultVisible: true,
  },
  {
    key: 'cache',
    label: 'Cache',
    description: 'Prompt cache hit rate',
    group: 'session',
    icon: Zap,
    defaultVisible: true,
  },
  {
    key: 'context',
    label: 'Context Usage',
    description: 'Context window utilization',
    group: 'session',
    icon: BarChart3,
    defaultVisible: true,
  },
  {
    key: 'usage',
    label: 'Usage & cost',
    description: 'Subscription utilization or session cost',
    group: 'session',
    icon: Gauge,
    defaultVisible: true,
  },
  {
    key: 'permission',
    label: 'Permission Mode',
    description: 'Agent permission level selector',
    group: 'controls',
    icon: Shield,
    defaultVisible: true,
  },
  {
    key: 'sound',
    label: 'Sound',
    description: 'Notification sound toggle',
    group: 'controls',
    icon: Volume2,
    defaultVisible: true,
  },
  {
    key: 'polling',
    label: 'Refresh',
    description: 'Background polling for updates',
    group: 'controls',
    icon: RefreshCw,
    defaultVisible: true,
  },
] as const;

/**
 * Bridge between a registry key and the server-persisted `ui.statusBar` config
 * (DOR-431): reads visibility from the config query and returns a setter that
 * PATCHes `/api/config`. The registry key already matches the config field name
 * (`'cwd'` → `ui.statusBar.cwd`), so no name mapping is needed.
 *
 * @param key - Status bar item key from the registry
 * @returns Tuple of [isVisible, setVisible]
 */
export function useStatusBarVisibility(key: StatusBarItemKey): [boolean, (value: boolean) => void] {
  const prefs = useStatusBarPrefs();
  const { setVisibility } = useUpdateStatusBarPrefs();
  const setVisible = useCallback(
    (value: boolean) => setVisibility(key, value),
    [setVisibility, key]
  );
  return [prefs[key], setVisible];
}

/**
 * Reset only status bar visibility preferences to their defaults (all items
 * visible). Does NOT touch other preferences (font, theme, timestamps, etc.).
 * Returns the reset function so callers wire it to a button/menu action.
 */
export function useResetStatusBarPreferences(): () => void {
  const { reset } = useUpdateStatusBarPrefs();
  return reset;
}

/** Return registry items grouped by their group field, in registry order. */
export function getGroupedRegistryItems(): {
  group: StatusBarItemGroup;
  label: string;
  items: StatusBarItemConfig[];
}[] {
  const groups: StatusBarItemGroup[] = ['session', 'controls'];
  return groups
    .map((group) => ({
      group,
      label: GROUP_LABELS[group],
      items: STATUS_BAR_REGISTRY.filter((item) => item.group === group),
    }))
    .filter((g) => g.items.length > 0);
}
