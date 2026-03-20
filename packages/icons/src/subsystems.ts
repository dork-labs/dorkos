/**
 * Subsystem definitions — canonical metadata for all DorkOS subsystems.
 *
 * @module icons/subsystems
 */
import type { LucideIcon } from 'lucide-react';
import { icons } from './registry';

export type SubsystemId = 'pulse' | 'relay' | 'mesh' | 'console' | 'loop' | 'wing';

export interface SubsystemDef {
  id: SubsystemId;
  label: string;
  icon: LucideIcon;
}

/** Ordered list of all DorkOS subsystems with their canonical icons. */
export const SUBSYSTEMS: readonly SubsystemDef[] = [
  { id: 'pulse', label: 'Pulse', icon: icons.pulse },
  { id: 'relay', label: 'Relay', icon: icons.relay },
  { id: 'mesh', label: 'Mesh', icon: icons.mesh },
  { id: 'console', label: 'Console', icon: icons.console },
  { id: 'loop', label: 'Loop', icon: icons.loop },
  { id: 'wing', label: 'Wing', icon: icons.wing },
] as const;
