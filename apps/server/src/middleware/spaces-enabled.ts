import type { Request, Response, NextFunction } from 'express';
import { configManager } from '../services/core/config-manager.js';

/** The `code` a space route answers with while the spaces experiment is off. */
export const SPACES_DISABLED_CODE = 'SPACES_DISABLED';

/**
 * Whether the spaces experiment is on (`spaces.enabled`, DOR-2740).
 *
 * Read on every call rather than once at boot, so flipping the switch in
 * Settings → Experiments takes effect without a restart. A config read is an
 * in-memory lookup.
 *
 * @returns True only when a person has turned spaces on.
 */
export function spacesEnabled(): boolean {
  return configManager.get('spaces')?.enabled === true;
}

/**
 * Gate for every route that reaches a space (a Community on another server):
 * `/api/communities`, `/api/community-connections` and `/api/cloud/communities`.
 *
 * While the experiment is off each one answers 404 with
 * {@link SPACES_DISABLED_CODE}, so a client can tell "this feature is off" from
 * "that space does not exist". This machine's own rooms never pass through
 * here. Nothing is deleted while it is off: turning it back on finds every
 * connection where it was left.
 */
export function requireSpacesEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!spacesEnabled()) {
    res.status(404).json({
      error: 'Spaces are switched off. Turn them on in Settings → Experiments.',
      code: SPACES_DISABLED_CODE,
    });
    return;
  }
  next();
}
