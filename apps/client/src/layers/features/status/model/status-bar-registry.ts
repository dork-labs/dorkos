import type { LucideIcon } from 'lucide-react';
import {
  FolderOpen,
  GitBranch,
  Bot,
  DollarSign,
  BarChart3,
  Zap,
  Gauge,
  Shield,
  Volume2,
  RefreshCw,
} from 'lucide-react';
import { useAppStore } from '@/layers/shared/model';

/** Union of all toggleable status bar item keys. */
export type StatusBarItemKey =
  | 'cwd'
  | 'git'
  | 'model'
  | 'cost'
  | 'cache'
  | 'context'
  | 'usage'
  | 'permission'
  | 'sound'
  | 'polling';

/** Grouping categories for the configure popover section headers. */
export type StatusBarItemGroup = 'session' | 'controls';

export interface StatusBarItemConfig {
  /** Unique key matching the Zustand store property suffix (e.g., 'cwd' -> showStatusBarCwd). */
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
    key: 'model',
    label: 'Model',
    description: 'Selected AI model',
    group: 'session',
    icon: Bot,
    defaultVisible: true,
  },
  {
    key: 'cost',
    label: 'Cost',
    description: 'Session cost in USD',
    group: 'session',
    icon: DollarSign,
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
    label: 'Usage',
    description: 'Subscription utilization',
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
 * Bridge between a registry key and the Zustand store's showStatusBar* / setShowStatusBar* properties.
 *
 * @param key - Status bar item key from the registry
 * @returns Tuple of [isVisible, setVisible]
 */
export function useStatusBarVisibility(key: StatusBarItemKey): [boolean, (value: boolean) => void] {
  // Build the getter/setter property names from the key: 'cwd' -> 'showStatusBarCwd' / 'setShowStatusBarCwd'
  const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
  const showProp = `showStatusBar${capitalizedKey}` as keyof ReturnType<
    typeof useAppStore.getState
  >;
  const setProp = `setShowStatusBar${capitalizedKey}` as keyof ReturnType<
    typeof useAppStore.getState
  >;

  const visible = useAppStore((s) => s[showProp] as boolean);
  const setVisible = useAppStore((s) => s[setProp] as (v: boolean) => void);

  return [visible, setVisible];
}

/**
 * Reset only status bar visibility preferences to their registry defaults.
 * Does NOT reset other preferences (font, theme, timestamps, etc.).
 */
export function resetStatusBarPreferences(): void {
  const store = useAppStore.getState();
  for (const item of STATUS_BAR_REGISTRY) {
    const capitalizedKey = item.key.charAt(0).toUpperCase() + item.key.slice(1);
    const setProp = `setShowStatusBar${capitalizedKey}` as keyof typeof store;
    const setter = store[setProp] as (v: boolean) => void;
    setter(item.defaultVisible);
  }
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
