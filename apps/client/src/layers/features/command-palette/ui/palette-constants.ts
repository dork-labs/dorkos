import {
  Clock,
  Radio,
  Globe,
  Settings,
  Plus,
  Search,
  FolderOpen,
  Moon,
  Shapes,
  MessageSquarePlus,
} from 'lucide-react';
import type { SearchableItem } from '../model/use-palette-search';

/**
 * What each kind of row is called where it appears in the ranked list.
 *
 * These are headings on ONE list, not groups that decide an order — the ranking
 * decides the order and a heading appears wherever the kind changes going down
 * (`groupRankedRows`). Two kinds share the word **Actions** on purpose: a
 * feature and a quick action are the same thing to the person reading the list,
 * and the distinction between them is a registry detail.
 *
 * Typed as a total record, so adding a kind of palette item is a type error here
 * until it has been given a name a person can read.
 */
export const RESULT_GROUP_LABEL: Record<SearchableItem['type'], string> = {
  session: 'Conversations',
  agent: 'Agents',
  room: 'Channels',
  dm: 'Direct Messages',
  command: 'Commands',
  feature: 'Actions',
  'quick-action': 'Actions',
};

/** The heading over the one row that stands clear of the rest (design-decisions §15). */
export const BEST_MATCH_HEADING = 'Best match';

/** Lucide icon name → component mapping for palette items. */
export const ICON_MAP: Record<string, React.ElementType> = {
  Clock,
  Radio,
  Globe,
  Settings,
  Plus,
  Search,
  FolderOpen,
  Moon,
  Shapes,
  MessageSquarePlus,
};

/** Ease-out curve for entrances (design system standard). */
export const EASE_OUT = [0, 0, 0.2, 1] as const;

/** Ease-in curve for exits (design system standard). */
export const EASE_IN = [0.4, 0, 1, 1] as const;

/** Dialog entrance/exit animation variants. */
export const dialogVariants = {
  hidden: { opacity: 0, scale: 0.96, y: -8 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: 0.2, ease: EASE_OUT },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: -8,
    transition: { duration: 0.12, ease: EASE_IN },
  },
} as const;

/** Stagger container variants — applied to a key-changed wrapper to re-trigger on open/page. */
export const listVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.035, delayChildren: 0.04 },
  },
} as const;

/** Stagger child variants — used on the first 8 items only. */
export const itemVariants = {
  hidden: { opacity: 0, y: -4 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, ease: EASE_OUT },
  },
} as const;
