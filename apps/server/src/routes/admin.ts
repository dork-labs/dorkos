import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import rateLimit from 'express-rate-limit';
import { env } from '../env.js';

/**
 * Error code accompanying the 409 when the desktop app owns the server's
 * lifecycle.
 *
 * The client renders `error` on its own now (`system-methods.ts` goes through
 * `fetchJSON`, which reads it off the body), so these messages are shown as
 * written rather than wrapped in the raw JSON they arrive in. The code is here
 * so a client CAN branch, and so logs and tests match on something stable.
 */
export const MANAGED_BY_DESKTOP_CODE = 'MANAGED_BY_DESKTOP';

/**
 * What each admin action says when the desktop app owns the lifecycle.
 *
 * Keyed by the router-relative path, normalized by
 * {@link desktopManagedMessage}. Restart and reset need different copy:
 * quitting and reopening the app IS a restart, so that advice completes the
 * user's intent, but it deletes nothing, so offering it for a reset would send
 * someone away believing their data was wiped when it was not.
 *
 * **Who still sees these.** Not the desktop app's own window: since DOR-542 the
 * cockpit asks the shell's supervisor over IPC, and both buttons really work
 * there. What is left is every OTHER client of a desktop-managed server — a
 * browser opened at its localhost address, a phone on the tunnel, a desktop
 * build older than that change — none of which can drive the shell, and all of
 * which are better off being told to do it at the machine.
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

/** Said when the refusal fires on a path with no specific copy (an unknown admin route). */
const GENERIC_DESKTOP_MANAGED_REFUSAL =
  'The DorkOS app starts and stops the server for you, so this action is not available here.';

/**
 * Pick the refusal copy for a request, tolerating every path spelling Express
 * still routes to a handler.
 *
 * Express 5 routes non-strictly, so `/reset/` reaches the `/reset` handler while
 * `req.path` reads `/reset/`, and it matches case-insensitively. A literal table
 * lookup missed both. Message selection is allowed to fall back; REFUSING is
 * not, which is why the caller refuses everything rather than keying off this
 * (see {@link createAdminRouter}).
 *
 * @param routerPath - `req.path`, relative to this router's mount point.
 * @param dorkHome - Data directory, named by the reset copy.
 */
function desktopManagedMessage(routerPath: string, dorkHome: string): string {
  const normalized = routerPath.toLowerCase().replace(/\/+$/, '') || '/';
  return DESKTOP_MANAGED_REFUSALS[normalized]?.(dorkHome) ?? GENERIC_DESKTOP_MANAGED_REFUSAL;
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

  // Refuses EVERY request into this router, not a list of paths. Every route
  // here ends the process, and one of them deletes the data directory first, so
  // "which path is this" must not be able to decide whether the guard runs. An
  // earlier revision keyed the refusal off `req.path` and Express's non-strict
  // routing walked straight around it: `POST /api/admin/reset/` reached the
  // handler and ran `fs.rm(dorkHome, { recursive: true })`, in the one mode
  // where the guard exists to prevent exactly that. Matching nothing cannot be
  // out-spelled; only the message text is chosen by path.
  //
  // Ahead of the rate limiter on purpose, too. A desktop-managed refusal is a
  // fixed fact about this deployment, not a burst of work to shed. Behind the
  // limiter, a person tapping Restart four times got "Too many admin requests"
  // for five minutes instead of the explanation that tells them what to do.
  router.use((req, res, next) => {
    if (env.DORKOS_MANAGED_BY !== 'desktop') {
      next();
      return;
    }
    res.status(409).json({
      error: desktopManagedMessage(req.path, deps.dorkHome),
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
