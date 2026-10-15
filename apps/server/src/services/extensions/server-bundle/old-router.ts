/**
 * What happens to an in-process server half written for the Express router
 * DorkOS no longer runs (DOR-2861): its card says so, the log says so once per
 * start, and the caller hears the plain message. Its page, settings and data
 * are untouched. The isolated host reports the same code
 * (`isolation/start-refusal.ts`).
 *
 * @module services/extensions/server-bundle/old-router
 */
import type { ExtensionRecord } from '@dorkos/extension-api';
import { OLD_ROUTER_MESSAGE, OldRouterError } from '@dorkos/extension-api/server';
import { extensionServerErrorCopy } from '@dorkos/shared/extension-server-status';
import { logger } from '../../../lib/logger.js';

/**
 * Turn a start failure into the old-router refusal, or `null` when it is any
 * other failure.
 *
 * @param err - What the start threw.
 * @param record - The extension's record, whose card the refusal is written to.
 */
export function refuseOldRouter(
  err: unknown,
  record: ExtensionRecord
): { ok: false; error: string } | null {
  if (!(err instanceof OldRouterError)) return null;
  const code = 'server_old_router';
  record.serverError = { code, message: extensionServerErrorCopy(code, record.manifest.name)! };
  logger.warn(`[Extensions] ${record.id}: ${OLD_ROUTER_MESSAGE}`);
  return { ok: false, error: OLD_ROUTER_MESSAGE };
}
