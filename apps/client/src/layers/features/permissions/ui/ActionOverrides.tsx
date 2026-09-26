import { useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import type {
  PermissionActionEntry,
  PermissionAreaEntry,
  PermissionState,
  PermissionSurface,
} from '@dorkos/shared/permissions';
import { useSetPermission, type PermissionScope } from '@/layers/entities/permissions';
import { Button, PermissionStateSwitch } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { STATE_LABEL } from '../lib/permission-copy';
import { reportPermissionFailure } from '../lib/report-failure';

/** Props for {@link ActionOverrides}. */
export interface ActionOverridesProps {
  /** Which layer the actions are shown and written at. */
  scope: PermissionScope;
  /** The area, with its actions resolved at that layer. */
  area: Pick<PermissionAreaEntry, 'id' | 'label' | 'floor'> & {
    actions: readonly PermissionActionEntry[];
  };
  /** Where a change is made, recorded with it. */
  surface: PermissionSurface;
}

/** Whether an action has a setting of its own at this layer. */
function setHere(action: PermissionActionEntry, scope: PermissionScope): boolean {
  return action.resolved.source === (scope.kind === 'agent' ? 'agent-action' : 'default-action');
}

/**
 * The single actions inside one area (spec `agent-permissions` D4).
 *
 * Collapsed, it lists only the actions set differently from their area, each
 * with its own Reset — "Except create rooms: Allowed" — so a change made on a
 * request card or here is never hidden behind a disclosure. "Show individual
 * actions" opens every action with its own switch. A destructive action that
 * follows its area says it will still ask, because an area-level Allowed never
 * reaches a destructive action on its own.
 *
 * @param props - See {@link ActionOverridesProps}.
 */
export function ActionOverrides({ scope, area, surface }: ActionOverridesProps) {
  const write = useSetPermission(scope);
  const [open, setOpen] = useState(false);
  if (area.actions.length === 0) return null;
  const own = area.actions.filter((action) => setHere(action, scope));
  const save = (action: PermissionActionEntry, next: PermissionState | null) =>
    write.mutate(
      { kind: 'patch', actions: { [action.id]: next }, surface },
      { onError: reportPermissionFailure }
    );

  const reset = (action: PermissionActionEntry) => (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 px-2 text-xs"
      disabled={write.isPending}
      aria-label={`Put ${action.title} back to ${area.label}`}
      onClick={() => save(action, null)}
    >
      <RotateCcw className="size-3.5" aria-hidden />
      Reset
    </Button>
  );

  return (
    <div
      className="flex flex-col items-start gap-1 pb-3"
      data-testid={`permission-actions-${area.id}`}
    >
      {!open && own.length > 0 ? (
        <ul className="w-full space-y-1" data-testid={`permission-action-exceptions-${area.id}`}>
          {own.map((action) => (
            <li key={action.id} className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground min-w-0">
                Except {action.title}: {STATE_LABEL[action.resolved.state]}
              </span>
              {reset(action)}
            </li>
          ))}
        </ul>
      ) : null}

      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 h-7 px-2 text-xs"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <ChevronDown
          className={cn('size-3.5 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
        {open ? 'Hide individual actions' : 'Show individual actions'}
      </Button>

      {open ? (
        <ul className="divide-border w-full divide-y" aria-label={`${area.label} actions`}>
          {area.actions.map((action) => {
            const here = setHere(action, scope);
            const hint = here
              ? 'Set on its own'
              : action.alwaysAsks
                ? 'Always asks, so you see what it would change'
                : action.resolved.destructiveAsk
                  ? 'Always asks unless you set it here'
                  : `Follows ${area.label}`;
            return (
              <li
                key={action.id}
                className="flex flex-col gap-2 py-2 @md:flex-row @md:items-center @md:justify-between"
                data-testid={`permission-action-${action.id}`}
              >
                <div className="min-w-0">
                  <p className="text-sm">{action.title}</p>
                  <p className="text-muted-foreground text-xs">{hint}</p>
                </div>
                <div className="flex items-center gap-1">
                  {here ? reset(action) : null}
                  <PermissionStateSwitch
                    value={action.resolved.state}
                    floor={area.floor || action.alwaysAsks === true}
                    disabled={write.isPending}
                    aria-label={action.title}
                    onChange={(next) => {
                      if (next !== action.resolved.state) save(action, next);
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
