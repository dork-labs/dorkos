import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import rateLimit from 'express-rate-limit';
import { env } from '../env.js';

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
