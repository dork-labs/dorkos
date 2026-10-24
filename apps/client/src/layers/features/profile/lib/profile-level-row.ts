/**
 * The Level row: what an agent actually runs at, resolved by the server from
 * the rule a launch uses (`GET /api/agents/:id/level`).
 *
 * @module features/profile/lib/profile-level-row
 */
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import type { ProfileRowModel, ProfileRowsContext } from './profile-rows';

/** The Level row's words for each stop. Spoken short: the row is a glance. */
const LEVEL_WORDS: Record<PermissionStop, string> = {
  ask: 'Ask',
  act: 'Act',
  autonomy: 'Full autonomy',
};

/** Every Level row's hover says what the level is not: a chat's own limit. */
const LEVEL_SCOPE = 'Before any per-chat limits.';

/**
 * The Level row. It opens Permissions, which is where the level is changed.
 *
 * @param ctx - The row context; only its `level` is read.
 */
export function levelRow(ctx: ProfileRowsContext): ProfileRowModel {
  const level = ctx.level;
  const base: ProfileRowModel = {
    id: 'level',
    kind: 'nav',
    label: 'Level',
    accessibleLabel: 'Agent level',
    value: null,
    hint: LEVEL_SCOPE,
    page: 'permissions',
  };
  if (!level) return base;
  if (level.effective === null) return { ...base, value: 'Runtime default' };
  const value = LEVEL_WORDS[level.effective];
  if (!level.cappedByPerson || level.declared === null) return { ...base, value };
  return {
    ...base,
    value,
    valueNote: 'held there by you',
    hint: `Set to ${LEVEL_WORDS[level.declared]}. ${LEVEL_SCOPE}`,
  };
}
