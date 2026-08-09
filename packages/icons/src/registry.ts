/**
 * Icon registry — semantic mapping of icon names to Lucide components.
 *
 * @module icons/registry
 */
import type { LucideIcon } from 'lucide-react';
import { Zap, Route, Network, Terminal, RefreshCw, FileArchive, Sparkles } from 'lucide-react';

/** Canonical icon mapping for DorkOS subsystems and common UI actions. */
export const icons = {
  tasks: Zap,
  relay: Route,
  mesh: Network,
  console: Terminal,
  loop: RefreshCw,
  wing: FileArchive,
  /**
   * A milestone a room marks — one mark for the whole family, never one per
   * kind of moment (team-room-home spec D5.1). A first agent, a first pull
   * request and a hundredth session are the same KIND of line to a reader
   * skimming a feed; what tells them apart is the sentence and the identity
   * beside it, not a second glyph to learn.
   */
  moment: Sparkles,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;
