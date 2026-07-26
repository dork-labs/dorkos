import { Router, type Response } from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import rateLimit from 'express-rate-limit';
import { env } from '../env.js';

/**
 * Error code returned with the 409 when the desktop app owns the server's
 * lifecycle. Stable contract: the client matches on it to show the right
 * "quit and reopen" copy instead of a generic failure.
 */
export const MANAGED_BY_DESKTOP_CODE = 'MANAGED_BY_DESKTOP';

/**
 * Refuse an action that ends this process when something else is responsible for
 * starting it again.
 *
 * `triggerRestart()` re-spawns `process.argv[0]`. Inside an Electron
 * `UtilityProcess` that is the packaged app executable rather than Node, so the
 * spawn produces no server and the exit leaves the desktop app with nothing to
 * talk to. Refusing is the only honest answer, and it is a 409 (conflict with
 * the current state of the server) rather than a 403, because nothing about the
 * caller is wrong.
 *
 * @param res - The response to write the 409 to.
 * @param action - What the caller asked for, e.g. `restarting`, in a sentence.
 * @returns `true` when the request was answered and the handler must stop.
 */
function refuseWhenDesktopManaged(res: Response, action: string): boolean {
  if (env.DORKOS_MANAGED_BY !== 'desktop') return false;
  res.status(409).json({
    error:
      `The DorkOS app starts and stops the server for you, so ${action} it from here ` +
      `would leave you with no server running. Quit DorkOS and open it again instead.`,
    code: MANAGED_BY_DESKTOP_CODE,
  });
  return true;
}

/** Dependencies injected into the admin router. */
export interface AdminDeps {
  /** Absolute path to the DorkOS data directory (~/.dork). */
  dorkHome: string;
  /** Gracefully tears down all running services without exiting. */
  shutdownServices: () => Promise<void>;
  /** Closes the consolidated database connection. */
  closeDb: () => void;
}

/**
 * Spawn a new server process and exit the current one.
 * In dev mode (tsx watch / turbo), a simple exit triggers the watcher restart.
 * In production / CLI mode, we spawn a detached child first.
 */
function triggerRestart(): void {
  if (env.NODE_ENV === 'development') {
    // Dev mode: nodemon/turbo watches for exit and restarts
    process.exit(0);
  } else {
    // Production/CLI mode: spawn new process, then exit
    const child = spawn(process.argv[0], process.argv.slice(1), {
      detached: true,
      stdio: 'inherit',
      // eslint-disable-next-line no-restricted-syntax -- passing full env to spawned child process
      env: process.env,
    });
    child.unref();
    process.exit(0);
  }
}

/**
 * Create the admin router with reset and restart endpoints.
 *
 * ## The `DORKOS_MANAGED_BY` contract
 *
 * Both endpoints end this process and count on something restarting it. That
 * holds for the CLI (which re-spawns itself) and for `tsx watch` in dev, but not
 * when a supervisor started the server as a child it does not restart. A
 * supervisor in that position sets `DORKOS_MANAGED_BY` in the server's
 * environment, and both endpoints then answer 409 with
 * {@link MANAGED_BY_DESKTOP_CODE} instead of exiting.
 *
 * `desktop` is the only value today: the Electron shell sets it before spawning
 * the server as a `UtilityProcess`. Setting it is the desktop's side of the
 * contract; refusing is this router's side.
 *
 * @param deps - Injected services and configuration
 */
export function createAdminRouter(deps: AdminDeps): Router {
  const router = Router();

  const adminLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3,
    message: { error: 'Too many admin requests. Try again later.' },
  });
  router.use(adminLimiter);

  router.post('/reset', (req, res) => {
    if (refuseWhenDesktopManaged(res, 'resetting')) return;

    const { confirm } = req.body ?? {};
    if (confirm !== 'reset') {
      res.status(400).json({
        error: 'Missing or invalid confirm field. Send { confirm: "reset" }.',
      });
      return;
    }

    res.status(200).json({ message: 'Reset initiated. Server will restart.' });

    setImmediate(async () => {
      try {
        await deps.shutdownServices();
        deps.closeDb();
        await fs.rm(deps.dorkHome, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; restart regardless
      }
      triggerRestart();
    });
  });

  router.post('/restart', (_req, res) => {
    if (refuseWhenDesktopManaged(res, 'restarting')) return;

    res.status(200).json({ message: 'Restart initiated.' });

    setImmediate(async () => {
      try {
        await deps.shutdownServices();
      } catch {
        // Best-effort teardown; restart regardless
      }
      triggerRestart();
    });
  });

  return router;
}
