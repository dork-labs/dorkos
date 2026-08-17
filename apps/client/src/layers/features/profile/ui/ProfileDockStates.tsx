/**
 * The three things the docked profile shows when it has no profile to show.
 *
 * Carried over from the retired panel unchanged in wording: they were already the
 * honest answers to "no agent picked", "still looking" and "picked, but there is
 * nothing there".
 *
 * @module features/profile/ui/ProfileDockStates
 */
import { AlertCircle, User } from 'lucide-react';
import { Skeleton } from '@/layers/shared/ui';

/** Shown when nothing has pointed the panel at an agent. */
export function NoAgentSelected() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="bg-muted flex size-12 items-center justify-center rounded-full">
        <User className="text-muted-foreground size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">No agent selected</p>
        <p className="text-muted-foreground text-xs">Select an agent to view its profile.</p>
      </div>
    </div>
  );
}

export interface AgentNotFoundProps {
  /** The directory that resolved to no agent this install can profile. */
  agentPath: string;
}

/**
 * Shown when the panel is pointed at a directory but nothing there can be
 * profiled — the folder went away, or the agent is on disk and not in the fleet,
 * which is the same dead end from the reader's side.
 */
export function AgentNotFound({ agentPath }: AgentNotFoundProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="bg-destructive/10 flex size-12 items-center justify-center rounded-full">
        <AlertCircle className="text-destructive size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Agent not found</p>
        <p className="text-muted-foreground font-mono text-xs break-all">{agentPath}</p>
        <p className="text-muted-foreground text-xs">The agent at this path could not be loaded.</p>
      </div>
    </div>
  );
}

/**
 * The portrait's shape while it loads, on a cold cache only.
 *
 * Once an agent has been drawn the panel keeps that one on screen instead — a
 * skeleton between two agents you already know reads as the panel breaking.
 */
export function ProfileDockSkeleton() {
  return (
    <div data-slot="profile-dock-skeleton" className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-col items-center gap-2 px-4 pt-6 pb-4">
        <Skeleton className="size-16 rounded-full" />
        <Skeleton className="mt-1 h-4 w-28 rounded" />
        <Skeleton className="h-3 w-16 rounded" />
        <Skeleton className="h-3 w-36 rounded" />
      </div>
      <div className="space-y-2 px-4">
        {['w-full', 'w-full', 'w-full'].map((w, i) => (
          <Skeleton key={i} className={`h-8 ${w} rounded`} />
        ))}
      </div>
    </div>
  );
}
