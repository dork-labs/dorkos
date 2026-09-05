import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import rateLimit from 'express-rate-limit';
import { rateLimitKey } from '../middleware/rate-limit-key.js';
import { env } from '../env.js';
import { ResetTokenStore } from '../services/core/auth/reset-token.js';

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
 * Error code accompanying the 403 when a reset arrives without a live one-time
 * token — missing, mistyped, expired, or already spent (DOR-1707).
 *
 * One code for all four on purpose. A caller holding a real token never sees any
 * of them, and telling an attacker whether its guess was the right shape, the
 * right value too late, or right but already used narrows nothing it should be
 * helped to narrow.
 */
export const RESET_TOKEN_REQUIRED_CODE = 'RESET_TOKEN_REQUIRED';

/** What a reset without a live token is told. */
const RESET_TOKEN_REQUIRED_MESSAGE =
  'Nothing has been deleted. Resetting DorkOS takes two steps now: ask DorkOS to start the ' +
  'reset, then confirm it within two minutes. Open Settings and start the reset again.';

/**
 * What both halves of a reset say when the desktop app owns the lifecycle.
 *
 * @param dorkHome - Data directory, named so "delete it yourself" is actionable.
 */
const desktopManagedResetRefusal = (dorkHome: string) =>
  'The DorkOS app starts and stops the server for you, so it cannot reset itself from here. ' +
  'Nothing has been deleted. To start over, quit DorkOS, delete the folder at ' +
  `${dorkHome}, then open DorkOS again. It will set itself up from scratch.`;

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
  '/reset': desktopManagedResetRefusal,
  // The first step of a reset gets the same answer as the second: a person who
  // arms a reset here is refused for the same reason and needs the same
  // instructions, and "this action is not available" would send them looking for
  // the button they already pressed.
  '/reset/prepare': desktopManagedResetRefusal,
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
 * ## Why resetting takes two requests (DOR-1707)
 *
 * `POST /reset` deletes the whole data directory, and `{ confirm: 'reset' }` is
 * a fixed string sitting in the client's source — it says the caller read the
 * docs, not that a person decided anything. Everything else in front of this
 * router is weaker than it looks in the posture most people run: `hostGuard`
 * lets every loopback name through, and with local login off the session gate is
 * a pass-through. One POST from anything on the machine wiped `~/.dork`.
 *
 * So a reset now needs a value the caller cannot know in advance:
 * `POST /reset/prepare` mints a single-use 256-bit token
 * (`services/core/auth/reset-token.ts`), and `POST /reset` refuses without it.
 *
 * **What that is worth, honestly.** It ends the one-shot attack: anything that
 * can only fire a request and never see the answer — a cross-site form or
 * `no-cors` fetch, a stale bookmark, an agent tool that posts a URL it was told
 * to post, a replayed log line — cannot reset this machine any more, because it
 * cannot read the token. With login ON it is a real credential bar: `/prepare`
 * rides the session gate like every other route, so only an authenticated caller
 * can arm a reset at all.
 *
 * With login OFF it is NOT re-authentication, and nothing here could be — there
 * is no credential to re-enter. A local process that can both send a request and
 * read the reply can still do the two steps in a row. Closing that needs an
 * identity this posture does not have; the desktop app already has one and does
 * not use this route at all (`apps/desktop/src/main/admin/index.ts` deletes the
 * directory over an origin-checked IPC channel instead).
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

  // Keys through the shared `rateLimitKey` — the TCP peer address, not the
  // spoofable `X-Forwarded-For` that `req.ip` derives from `trust proxy`
  // (DOR-1711). Three attempts per five minutes on routes that end the process
  // and can delete the data directory is a budget worth being able to reach.
  //
  // Attached per route rather than with `router.use`, because the two kinds of
  // request here cost different things. `adminLimiter` is ONE instance shared by
  // `/reset` and `/restart`, so the budget for ending this process is exactly
  // what it always was: three in five minutes, counted across both.
  const adminLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3,
    keyGenerator: rateLimitKey,
    message: { error: 'Too many admin requests. Try again later.' },
  });

  // Arming a reset changes nothing and deletes nothing, so it is not spent from
  // the acting budget — a person who starts a reset, cancels, and starts again
  // would otherwise have burned the requests they need to finish one. It is
  // limited on its own so a flood of mints cannot become free work, and it keys
  // through `rateLimitKey` like every other limiter here: a bucket a header can
  // move is not a bucket (DOR-1711).
  const prepareLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10,
    keyGenerator: rateLimitKey,
    message: { error: 'Too many admin requests. Try again later.' },
  });

  const resetTokens = new ResetTokenStore();

  /**
   * `POST /api/admin/reset/prepare` — hand out the one-time token `POST /reset`
   * demands. See {@link createAdminRouter} for what this does and does not buy.
   */
  router.post('/reset/prepare', prepareLimiter, (_req, res) => {
    res.status(200).json(resetTokens.mint());
  });

  router.post('/reset', adminLimiter, (req, res) => {
    const { confirm, token } = req.body ?? {};
    if (confirm !== 'reset') {
      res.status(400).json({
        error: 'Missing or invalid confirm field. Send { confirm: "reset" }.',
      });
      return;
    }

    // Checked BEFORE anything is torn down, and it is the last word: no branch
    // below this reaches `fs.rm` without a token that was minted, unexpired, and
    // unspent.
    if (!resetTokens.consume(token)) {
      res.status(403).json({
        error: RESET_TOKEN_REQUIRED_MESSAGE,
        code: RESET_TOKEN_REQUIRED_CODE,
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

  router.post('/restart', adminLimiter, (_req, res) => {
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
