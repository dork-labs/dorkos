import { cn } from '@/layers/shared/lib';
import { Badge } from '@/layers/shared/ui';
import type { ActorType } from '../model/activity-types';
import { ACTOR_CONFIG } from '../model/activity-types';

export interface ActorBadgeProps {
  /** The actor type determines the visual treatment. */
  actorType: ActorType;
  /** Human-readable actor label ("You", agent name, "System", "Tasks"). */
  actorLabel: string;
  /**
   * CSS color string for agent actors (e.g., a hex or `oklch(...)` value).
   * Only used when `actorType === 'agent'`.
   */
  agentColor?: string;
  className?: string;
}

/**
 * Actor pill rendered on each activity row.
 *
 * - `user` → neutral ghost pill "You"
 * - `agent` → colored dot + name (dot uses `agentColor`)
 * - `system` → Settings icon, muted neutral
 * - `tasks` → Clock icon, purple
 */
export function ActorBadge({ actorType, actorLabel, agentColor, className }: ActorBadgeProps) {
  const config = ACTOR_CONFIG[actorType];
  const Icon = config.icon;

  if (actorType === 'user') {
    return (
      <Badge
        data-slot="actor-badge"
        shape="pill"
        variant="outline"
        className={cn('text-muted-foreground', className)}
      >
        {actorLabel}
      </Badge>
    );
  }

  if (actorType === 'agent') {
    return (
      <span
        data-slot="actor-badge"
        className={cn(
          'inline-flex items-center gap-1.5 text-xs font-medium',
          config.text,
          className
        )}
      >
        <span
          className="size-2 shrink-0 rounded-full"
          style={agentColor ? { backgroundColor: agentColor } : undefined}
          aria-hidden
        />
        <span className="truncate">{actorLabel}</span>
      </span>
    );
  }

  // system | tasks — icon + label
  return (
    <span
      data-slot="actor-badge"
      className={cn('inline-flex items-center gap-1 text-xs font-medium', config.text, className)}
    >
      {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
      <span>{actorLabel}</span>
    </span>
  );
}
