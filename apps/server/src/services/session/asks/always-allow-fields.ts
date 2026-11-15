/**
 * The two "Always Allow" facts an approval card carries, read off a raw stream
 * event for the session-stream member.
 *
 * @module services/session/asks/always-allow-fields
 */
import { AlwaysAllowBreadthSchema, AlwaysAllowScopeSchema } from '@dorkos/shared/schemas';
import type { AlwaysAllowBreadth, AlwaysAllowScope } from '@dorkos/shared/types';

/**
 * The scope and breadth an approval event names, each only when it is a value
 * the card knows.
 *
 * Validated rather than cast: the scope drives the sentence beside "Always
 * Allow" and the breadth decides whether the card offers a whole MCP server
 * (DOR-4101), so a runtime that shipped an unrecognised word would have the card
 * make a promise nobody wrote. An unreadable value is simply absent, which
 * renders as the plain button it always was.
 *
 * @param data - The raw event's data.
 */
export function alwaysAllowFieldsOf(data: Record<string, unknown>): {
  alwaysAllowScope?: AlwaysAllowScope;
  alwaysAllowBreadth?: AlwaysAllowBreadth;
} {
  const scope = AlwaysAllowScopeSchema.safeParse(data.alwaysAllowScope);
  const breadth = AlwaysAllowBreadthSchema.safeParse(data.alwaysAllowBreadth);
  return {
    ...(scope.success ? { alwaysAllowScope: scope.data } : {}),
    ...(breadth.success ? { alwaysAllowBreadth: breadth.data } : {}),
  };
}
