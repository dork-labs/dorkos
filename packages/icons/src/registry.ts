/**
 * Icon registry — semantic mapping of icon names to Lucide components.
 *
 * @module icons/registry
 */
import type { LucideIcon } from 'lucide-react'
import {
  HeartPulse,
  Route,
  Network,
  Terminal,
  RefreshCw,
  FileArchive,
} from 'lucide-react'

/** Canonical icon mapping for DorkOS subsystems and common UI actions. */
export const icons = {
  pulse: HeartPulse,
  relay: Route,
  mesh: Network,
  console: Terminal,
  loop: RefreshCw,
  wing: FileArchive,
} as const satisfies Record<string, LucideIcon>

export type IconName = keyof typeof icons
