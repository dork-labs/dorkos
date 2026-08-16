/**
 * Runs on — the runtime, the model and the effort an agent starts a turn with
 * (spec `profile-unification` §1.4).
 *
 * The Agent Hub spread these across a Config tab as three separate fields. They
 * are one answer to one question, so they are one popover: which engine, which
 * model on it, and how hard it thinks.
 *
 * @module features/profile/ui/popovers/RunsOnPopover
 */
import { Folder } from 'lucide-react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { shortenHomePath } from '@/layers/shared/lib';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/layers/shared/ui';
import { AgentExecutionRows } from '@/layers/entities/agent';
import { getRuntimeDescriptor, useRuntimeCapabilities } from '@/layers/entities/runtime';
import { useProfileAgent } from '../../model/use-profile-agent';
import type { ProfilePickContentProps } from './types';

/** The field-label style the three settings share. */
const LABEL_CLASS = 'text-muted-foreground text-[10px] font-medium tracking-wider uppercase';

/**
 * Change what an agent runs on.
 *
 * The runtime is a plain select and the other two are provenance-bearing rows,
 * because they are different kinds of fact: a runtime is either connected here
 * or it is not, while a model and an effort can each be set here, inherited from
 * the server, or set to something the runtime no longer offers.
 */
export function RunsOnPopover({ member }: ProfilePickContentProps) {
  const { agent, projectPath, isPending, update } = useProfileAgent(member);
  const { data: capabilities } = useRuntimeCapabilities();

  if (isPending) return <Skeleton className="h-24 w-full" />;
  if (!agent) {
    return (
      <p className="text-muted-foreground p-1 text-sm">Couldn’t read this agent’s settings.</p>
    );
  }

  const registered = capabilities ? Object.keys(capabilities.capabilities) : [agent.runtime];
  // The agent's OWN runtime always appears, registered or not. Without it the
  // dropdown renders empty for an agent pointed at a runtime this machine has
  // not connected — precisely the agent the Settings exceptions strip sends
  // people here to fix, and a blank field tells them nothing about what is wrong.
  const runtimes = registered.includes(agent.runtime) ? registered : [agent.runtime, ...registered];

  return (
    <div className="space-y-3 p-1" data-slot="profile-runs-on">
      <div className="space-y-1">
        <div className={LABEL_CLASS}>Runtime</div>
        <Select
          value={agent.runtime ?? 'claude-code'}
          onValueChange={(value) => update({ runtime: value } as Partial<AgentManifest>)}
        >
          <SelectTrigger className="h-8 text-sm" responsive={false}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {runtimes.map((type) => (
              <SelectItem key={type} value={type} responsive={false}>
                {getRuntimeDescriptor(type).label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <AgentExecutionRows agent={agent} onUpdate={update} />

      {/* Where it runs, as a fact rather than a control — the folder is what an
          agent IS, and there is no changing it from here. */}
      {projectPath && (
        <div className="text-muted-foreground flex items-center gap-1.5">
          <Folder aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate font-mono text-xs">{shortenHomePath(projectPath)}</span>
        </div>
      )}
    </div>
  );
}
