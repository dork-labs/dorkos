import type { Hono } from 'hono';
import type { Pool } from 'pg';
import type { CommunityAuth } from '../../auth.js';
import type { CommunityConfig } from '../../config.js';
import { registerBanRoutes } from './bans.js';
import { registerConductRoutes } from './conduct.js';
import { registerReportRoutes } from './reports.js';

/**
 * Register a space's moderation (specs/official-community-space D6-D8): bans, mutes, rules,
 * reserved and chosen display names, slow mode, and the report queue.
 */
export function registerModerationRoutes(
  app: Hono,
  deps: { pool: Pool; auth: CommunityAuth; config: CommunityConfig }
): void {
  registerBanRoutes(app, deps);
  registerConductRoutes(app, deps);
  registerReportRoutes(app, deps);
}
