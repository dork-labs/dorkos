import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import rateLimit from 'express-rate-limit';
import { env } from '../env.js';

/**
 * Error code accompanying the 409 when the desktop app owns the server's
 * lifecycle.
 *
 * The client does not branch on it today: `system-methods.ts` throws the raw
 * response text and the Advanced tab toasts that message, so what a person
 * actually reads is the `error` string below. That is why each message has to
 * stand on its own. The code is here so a future client CAN branch, and so logs
 * and tests have something stable to match.
 */
export const MANAGED_BY_DESKTOP_CODE = 'MANAGED_BY_DESKTOP';

/**
 * What each admin action says when the desktop app owns the lifecycle.
 *
 * Keyed by the router-relative path so the refusal can run ahead of the rate
 * limiter (see {@link createAdminRouter}). Restart and reset need different
 * copy: quitting and reopening the app IS a restart, so that advice completes
 * the user's intent, but it deletes nothing, so offering it for a reset would
 * send someone away believing their data was wiped when it was not.
 */
const DESKTOP_MANAGED_REFUSALS: Record<string, (dorkHome: string) => string> = {
  '/restart': () =>
    'The DorkOS app starts and stops the server for you, so restarting it from here would ' +
    'leave you with no server running. Quit DorkOS and open it again instead. That does the ' +
    'same thing.',
  '/reset': (dorkHome) =>
    'The DorkOS app starts and stops the server for you, so it cannot reset itself from here. ' +
    'Nothing has been deleted. To start over, quit DorkOS, delete the folder at ' +
    `${dorkHome}, then open DorkOS again. It will set itself up from scratch.`,
};

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

  // Ahead of the rate limiter on purpose. A desktop-managed refusal is a fixed
  // fact about this deployment, not a burst of work to shed, and it costs
  // nothing to answer. Behind the limiter, a person tapping Restart four times
  // would get "Too many admin requests" for five minutes instead of the
  // explanation that tells them what to do.
  router.use((req, res, next) => {
    if (env.DORKOS_MANAGED_BY !== 'desktop') {
      next();
      return;
    }
    // Express routes case-insensitively, so normalize before the lookup.
    const buildMessage = DESKTOP_MANAGED_REFUSALS[req.path.toLowerCase()];
    if (!buildMessage) {
      next();
      return;
    }
    res.status(409).json({
      error: buildMessage(deps.dorkHome),
      code: MANAGED_BY_DESKTOP_CODE,
    });
  });

  const adminLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3,
    message: { error: 'Too many admin requests. Try again later.' },
  });
  router.use(adminLimiter);

  router.post('/reset', (req, res) => {
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
