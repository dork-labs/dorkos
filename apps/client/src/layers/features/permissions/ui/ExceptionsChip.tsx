import { ChevronRight, RotateCcw } from 'lucide-react';
import type { PermissionAreaId, PermissionException } from '@dorkos/shared/permissions';
import { useSetPermission } from '@/layers/entities/permissions';
import {
  Button,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from '@/layers/shared/ui';
import { STATE_LABEL } from '../lib/permission-copy';

/** Props for {@link ExceptionsChip}. */
export interface ExceptionsChipProps {
  /** The area the exceptions are about. */
  area: PermissionAreaId;
  /** The area's label, for the list heading. */
  areaLabel: string;
  /** The agents set differently for this area. */
  agents: readonly PermissionException[];
}

/** One differing agent, with its own Reset. */
function ExceptionRow({
  area,
  exception,
}: {
  area: PermissionAreaId;
  exception: PermissionException;
}) {
  const write = useSetPermission({ kind: 'agent', agentId: exception.agentId });
  const reset = () =>
    write.mutate({
      kind: 'patch',
      ...(exception.action
        ? { actions: { [exception.action]: null } }
        : { areas: { [area]: null } }),
      surface: 'settings',
    });
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-sm">
        {exception.agentName}: {STATE_LABEL[exception.state]}
        {exception.action ? ' (one action)' : ''}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={reset}
        disabled={write.isPending}
        aria-label={`Reset ${exception.agentName} to the default`}
      >
        <RotateCcw className="size-3.5" aria-hidden />
        Reset
      </Button>
    </li>
  );
}

/**
 * "2 agents differ ›": the agents set differently from the default for one
 * area, each with its state and a Reset that puts it back on the default.
 * Renders nothing when no agent differs.
 *
 * @param props - See {@link ExceptionsChipProps}.
 */
export function ExceptionsChip({ area, areaLabel, agents }: ExceptionsChipProps) {
  if (agents.length === 0) return null;
  const label = agents.length === 1 ? '1 agent differs' : `${agents.length} agents differ`;
  return (
    <ResponsivePopover>
      <ResponsivePopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground self-start md:self-end">
          {label}
          <ChevronRight className="size-3.5" aria-hidden />
        </Button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent className="w-80 space-y-2">
        <ResponsivePopoverTitle className="text-sm font-medium">
          Set differently for {areaLabel}
        </ResponsivePopoverTitle>
        <ul className="space-y-1">
          {agents.map((exception) => (
            <ExceptionRow key={exception.agentId} area={area} exception={exception} />
          ))}
        </ul>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
