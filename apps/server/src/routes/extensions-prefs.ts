/**
 * `GET|PUT /api/extensions/:id/prefs` — an app's screen data (DOR-3293,
 * Security item 7).
 *
 * What an app's screens save (`api.saveData` / `api.loadData` inside its
 * frame) lives in its own file, `prefs.json`, beside — never in — the
 * `data.json` its server half keeps through `ctx.storage`. The frame can
 * therefore never read or overwrite the server half's data. Writes are bound to
 * the app that makes them, like every other extension write
 * (`extension-write-binding.ts`), and capped in size.
 *
 * @module routes/extensions-prefs
 */
import fs from 'fs/promises';
import path from 'path';
import type { Hono } from 'hono';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import { resolveExtensionDataDir } from '../services/extensions/extension-data-paths.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { refusedExtensionWrite } from './extension-write-binding.js';

/** The file an app's screen data lives in, beside its server half's `data.json`. */
export const PREFS_FILENAME = 'prefs.json';

/** The most screen data one app may keep: 512 KB of JSON. */
export const PREFS_MAX_BYTES = 512 * 1024;

/** What the prefs routes read from the extensions router. */
export interface ExtensionPrefsDeps {
  manager: ExtensionManager;
  dorkHome: string;
  getCwd: () => string | null;
  safeId: RegExp;
}

/**
 * Register the screen-data routes on the extensions router.
 *
 * @param router - The `/api/extensions` router.
 * @param deps - The extension manager and where data folders live.
 */
export function registerExtensionPrefsRoutes(router: Hono<ApiEnv>, deps: ExtensionPrefsDeps) {
  const prefsPath = (id: string): string | null => {
    const dir = resolveExtensionDataDir(id, deps.manager, deps.dorkHome, deps.getCwd);
    return dir === null ? null : path.join(dir, PREFS_FILENAME);
  };

  router.get('/:id/prefs', async (c) => {
    const id = c.req.param('id');
    if (!deps.safeId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
    const file = prefsPath(id);
    if (!file) return c.json({ error: `Extension '${id}' not found` }, 404);
    try {
      return c.json(JSON.parse(await fs.readFile(file, 'utf-8')));
    } catch {
      return c.body(null, 204);
    }
  });

  router.put('/:id/prefs', async (c) => {
    const id = c.req.param('id');
    if (!deps.safeId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
    const refused = refusedExtensionWrite(c, id);
    if (refused) return refused;
    const file = prefsPath(id);
    if (!file) return c.json({ error: `Extension '${id}' not found` }, 404);
    const value = readJsonBody(c);
    if (value === undefined) return c.json({ error: 'Send the data to save, as JSON.' }, 400);
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, 'utf-8') > PREFS_MAX_BYTES) {
      return c.json({ error: 'That is more than an app may save (512 KB).' }, 413);
    }
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, text);
      return c.json({ ok: true }, 200);
    } catch (err) {
      logger.error(`[Extensions] Failed to write screen data for ${id}`, err);
      return c.json({ error: 'Failed to save the app’s data' }, 500);
    }
  });
}
