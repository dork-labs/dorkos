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
} from 'lucide-react';

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
