/**
 * Which pages this build can push, and what each is called (spec
 * `profile-unification` §1.5).
 *
 * **The registry is the seam.** The row model (`lib/profile-rows`) is the
 * contract with §1.4 and names every page the design has, but a row is only
 * drawn when its page exists here — so a page that has not been built yet is
 * absent rather than dead, and building one is a single entry with no change to
 * the row table.
 *
 * @module features/profile/ui/pages/registry
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ProfilePageId } from '../../model/profile-stack';
import type { ProfilePageContentProps } from './types';

/** One registered page: its title, and the content under it. */
export interface ProfilePageDefinition {
  /** The `h2` at the top of the page. */
  title: string;
  /** The content, code-split — a profile that never opens a page loads none of them. */
  component: LazyExoticComponent<ComponentType<ProfilePageContentProps>>;
}

/** Every page this build has. */
const PROFILE_PAGES: Partial<Record<ProfilePageId, ProfilePageDefinition>> = {
  about: {
    title: 'About',
    component: lazy(() => import('./AboutPage').then((m) => ({ default: m.AboutPage }))),
  },
  manages: {
    title: 'Manages',
    component: lazy(() => import('./ManagesPage').then((m) => ({ default: m.ManagesPage }))),
  },
  rooms: {
    title: 'Rooms',
    component: lazy(() => import('./RoomsPage').then((m) => ({ default: m.RoomsPage }))),
  },
  name: {
    title: 'Name',
    component: lazy(() => import('./NamePage').then((m) => ({ default: m.NamePage }))),
  },
  handle: {
    title: 'Handle',
    component: lazy(() => import('./HandlePage').then((m) => ({ default: m.HandlePage }))),
  },
  photo: {
    title: 'Photo',
    component: lazy(() => import('./PhotoPage').then((m) => ({ default: m.PhotoPage }))),
  },
  appearance: {
    title: 'Appearance',
    component: lazy(() => import('./AppearancePage').then((m) => ({ default: m.AppearancePage }))),
  },
  sessions: {
    title: 'Sessions',
    component: lazy(() => import('./SessionsPage').then((m) => ({ default: m.SessionsPage }))),
  },
  tasks: {
    title: 'Tasks',
    component: lazy(() => import('./TasksPage').then((m) => ({ default: m.TasksPage }))),
  },
  notifications: {
    title: 'Notifications',
    component: lazy(() =>
      import('./NotificationsPage').then((m) => ({ default: m.NotificationsPage }))
    ),
  },
  skills: {
    title: 'Skills',
    component: lazy(() => import('./SkillsPage').then((m) => ({ default: m.SkillsPage }))),
  },
  tools: {
    title: 'Tools & MCP',
    component: lazy(() => import('./ToolsPage').then((m) => ({ default: m.ToolsPage }))),
  },
  connections: {
    title: 'Connections',
    component: lazy(() =>
      import('./ConnectionsPage').then((m) => ({ default: m.ConnectionsPage }))
    ),
  },
  instructions: {
    title: 'Instructions',
    component: lazy(() =>
      import('./ConventionPage').then((m) => ({ default: m.InstructionsPage }))
    ),
  },
  boundaries: {
    title: 'Boundaries',
    component: lazy(() => import('./ConventionPage').then((m) => ({ default: m.BoundariesPage }))),
  },
};

/**
 * The page behind an id, or `null` when this build does not have it.
 *
 * @param id - The page a row wants to push.
 */
export function profilePage(id: ProfilePageId): ProfilePageDefinition | null {
  return PROFILE_PAGES[id] ?? null;
}

/**
 * Can this page be pushed at all? Rows whose page cannot are not drawn.
 *
 * @param id - The page a row wants to push.
 */
export function isProfilePageAvailable(id: ProfilePageId): boolean {
  return PROFILE_PAGES[id] !== undefined;
}
