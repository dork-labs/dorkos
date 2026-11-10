/** Durable permission bounds for deferred work, including explicit requeues. */
import { z } from 'zod';
import type { AgentWorkItemRow } from '@dorkos/db';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { READ_ONLY_LEVEL, stricterLevel } from '@dorkos/shared/permission-semantics';
import type { WorkQueueStore } from './work-queue-store.js';

const LevelSchema = z.object({
  asks: z.enum(['always', 'when-risky', 'never']),
  reach: z.enum(['read', 'edit', 'workspace', 'everything']),
  auto: z.literal(true).optional(),
  outsider: z.literal(true).optional(),
  teammate: z.array(z.object({ roomId: z.string(), authorId: z.string() })).optional(),
});

/** Unreadable or legacy agent provenance can only reduce power and add a mark. */
function readLevel(value: string | null): TurnPermissionLevel {
  try {
    return LevelSchema.parse(JSON.parse(value ?? 'null'));
  } catch {
    return { ...READ_ONLY_LEVEL, outsider: true };
  }
}

/** Intersect the live target, the requester and the first run; persist before starting. */
export function queuedWorkLevel(
  store: WorkQueueStore,
  item: AgentWorkItemRow | Pick<AgentWorkItemRow, 'id' | 'addedBy'>,
  target: TurnPermissionLevel
): TurnPermissionLevel {
  const authority = store.authority(item.id);
  let level =
    item.addedBy === 'agent'
      ? stricterLevel(target, readLevel(authority?.requestedLevel ?? null))
      : target;
  if (authority?.firstRunLevel) level = stricterLevel(level, readLevel(authority.firstRunLevel));
  store.recordAuthority({ itemId: item.id });
  store.pinFirstRunLevel(item.id, JSON.stringify(level));
  return level;
}
