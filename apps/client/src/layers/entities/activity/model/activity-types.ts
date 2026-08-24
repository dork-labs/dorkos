/**
 * Activity entity model — re-exports shared types and defines client-side
 * display configuration for actor and category rendering.
 *
 * @module entities/activity/model
 */
import type { LucideIcon } from 'lucide-react';
import { Clock, Settings } from 'lucide-react';

export type {
  ActivityItem,
  ActivityCategory,
  ActorType,
  ListActivityQuery,
  ListActivityResponse,
} from '@dorkos/shared/activity-schemas';

// ---------------------------------------------------------------------------
// Category display config
// ---------------------------------------------------------------------------

/** Display configuration for an activity category. */
export interface CategoryConfig {
  /** Tailwind text color class. */
  text: string;
  /** Tailwind background color class (semi-transparent). */
  bg: string;
  /** Human-readable label. */
  label: string;
}

/**
 * Per-category color tokens consistent with the dashboard activity feed.
 * Matches the spec: tasks=purple-500, relay=teal-500, agent=indigo-500,
 * config=amber-500, system=neutral-500.
 */
export const CATEGORY_CONFIG: Record<
  'tasks' | 'relay' | 'agent' | 'config' | 'system',
  CategoryConfig
> = {
  tasks: { text: 'text-purple-500', bg: 'bg-purple-500/10', label: 'Schedules' },
  relay: { text: 'text-teal-500', bg: 'bg-teal-500/10', label: 'Relay' },
  agent: { text: 'text-indigo-500', bg: 'bg-indigo-500/10', label: 'Agent' },
  config: { text: 'text-amber-500', bg: 'bg-amber-500/10', label: 'Config' },
  system: { text: 'text-neutral-500', bg: 'bg-neutral-500/10', label: 'System' },
};

// ---------------------------------------------------------------------------
// Actor display config
// ---------------------------------------------------------------------------

/** Display configuration for an actor type. */
export interface ActorConfig {
  /**
   * Lucide icon to render. Only present for `system` and `tasks` actors.
   * For `agent` actors, a colored dot is used instead; for `user`, a ghost pill.
   */
  icon?: LucideIcon;
  /** Tailwind text color class for the icon/label. */
  text: string;
}

/**
 * Per-actor-type visual configuration.
 * - `user` → neutral ghost pill (no icon, muted text)
 * - `agent` → colored dot + name (color supplied by caller from registry)
 * - `system` → Settings icon, muted neutral text
 * - `tasks` → Clock icon, purple text
 */
export const ACTOR_CONFIG: Record<'user' | 'agent' | 'system' | 'tasks', ActorConfig> = {
  user: { text: 'text-muted-foreground' },
  agent: { text: 'text-foreground' },
  system: { icon: Settings, text: 'text-neutral-500' },
  tasks: { icon: Clock, text: 'text-purple-500' },
};
