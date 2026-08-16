/**
 * Which pages this build can push, and what each is called (spec
 * `profile-unification` §1.5).
 *
 * **The registry is the seam between waves.** The row model (`lib/profile-rows`)
 * is complete from W2.1 — it is the contract with §1.4 — but a row is only
 * drawn when its page exists here, so the managed-agent rows W2.2 owns
 * (sessions, tasks, skills, tools, connections, instructions, boundaries,
 * appearance) are absent rather than dead until W2.2 registers them. Adding a
 * page is one entry; no row table changes.
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
