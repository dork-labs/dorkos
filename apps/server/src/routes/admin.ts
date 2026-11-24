import { spawn } from 'child_process';
import fs from 'fs/promises';
import { Hono, type Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRateLimit } from '../http/rate-limiter.js';
import { problem, problemBody, readJsonBody } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { refuseFrontDoorChange } from '../lib/caller-authority.js';
import { env } from '../env.js';
import { ResetTokenStore, RESET_TOKEN_TTL_DESCRIPTION } from '../services/core/auth/reset-token.js';

/**
 * A reset wipes the data folder, sign-ins and keys included, so it is a
 * front-door change (DOR-2969): only the owner, at this computer, in the app.
 */
function refuseResetAway(c: Context<ApiEnv>): Response | undefined {
  const refusal = refuseFrontDoorChange(honoRequestFacts(c), 'DorkOS');
  if (!refusal) return undefined;
  return problem(c, 'operator_only', {
    detail: 'Reset DorkOS in the app on the computer it runs on.',
  });
}

/**
 * What a reset without a live one-time token is told: missing, mistyped,
 * expired or already spent (DOR-1707). One answer for all four on purpose. A
 * caller holding a real token never sees it, and telling an attacker whether
 * its guess was the right shape, the right value too late, or right but already
 * used narrows nothing it should be helped to narrow.
 */
const RESET_TOKEN_REQUIRED_MESSAGE = `Nothing was deleted. Start the reset again, then confirm within ${RESET_TOKEN_TTL_DESCRIPTION}.`;

/**
 * What both halves of a reset say when the desktop app owns the lifecycle. It
 * names no folder: a problem's detail never carries a path.
 */
const DESKTOP_MANAGED_RESET_REFUSAL =
  'Nothing was deleted. Quit DorkOS, delete its data folder, then open it again.';

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
const DESKTOP_MANAGED_REFUSALS: Record<string, string> = {
  '/restart': 'Quit DorkOS and open it again. That restarts the server.',
  '/reset': DESKTOP_MANAGED_RESET_REFUSAL,
  // The first step of a reset gets the same answer as the second: a person who
  // arms a reset here is refused for the same reason and needs the same
  // instructions, and "this action is not available" would send them looking for
  // the button they already pressed.
  '/reset/prepare': DESKTOP_MANAGED_RESET_REFUSAL,
};

/** Said when the refusal fires on a path with no specific copy (an unknown admin route). */
const GENERIC_DESKTOP_MANAGED_REFUSAL = 'The DorkOS app runs this server, so do this there.';

/** Where the admin routes are mounted. */
const ADMIN_MOUNT = '/api/admin';

/**
 * Pick the refusal copy for a request, tolerating every path spelling that
 * reaches a handler.
 *
 * Routing is non-strict, so `/reset/` reaches the `/reset` handler while the
 * path reads `/reset/`, and a person may type it in any case. A literal table
 * lookup missed both. Message selection is allowed to fall back; REFUSING is
 * not, which is why the caller refuses everything rather than keying off this
 * (see {@link createAdminRoutes}).
 *
 * @param routerPath - The request path, relative to the admin mount.
 */
function desktopManagedMessage(routerPath: string): string {
  const normalized = routerPath.toLowerCase().replace(/\/+$/, '') || '/';
  return DESKTOP_MANAGED_REFUSALS[normalized] ?? GENERIC_DESKTOP_MANAGED_REFUSAL;
}

/** Every admin limiter's refusal. */
const TOO_MANY_ADMIN_REQUESTS = problemBody('rate_limited', {
  detail: 'Too many admin requests. Try again later.',
});

/** Dependencies injected into the admin router. */
export interface AdminDeps {
  /** Absolute path to the DorkOS data directory (~/.dork). */
  dorkHome: string;
  /** Gracefully tears down all running services without exiting. */
  shutdownServices: (reason?: 'authority' | 'shutdown') => Promise<void>;
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
 * Create the admin routes: reset and restart.
 *
 * ## The `DORKOS_MANAGED_BY` contract
 *
 * Both endpoints end this process and count on something restarting it. That
 * holds for the CLI (which re-spawns itself) and for `tsx watch` in dev, but not
 * when a supervisor started the server as a child it does not restart. A
 * supervisor in that position sets `DORKOS_MANAGED_BY` in the server's
 * environment, and both endpoints then answer 409 with
 * `managed_by_desktop` instead of exiting.
 *
 * `desktop` is the only value today: the Electron shell sets it before spawning
 * the server as a `UtilityProcess`. Setting it is the desktop's side of the
 * contract; refusing is these routes' side.
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
export function createAdminRoutes(deps: AdminDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // Refuses EVERY request under the mount, not a list of paths. Every route
  // here ends the process, and one of them deletes the data directory first, so
  // "which path is this" must not be able to decide whether the guard runs. An
  // earlier revision keyed the refusal off the path and non-strict routing
  // walked straight around it: `POST /api/admin/reset/` reached the handler and
  // ran `fs.rm(dorkHome, { recursive: true })`, in the one mode where the guard
  // exists to prevent exactly that. Matching nothing cannot be out-spelled;
  // only the message text is chosen by path.
  //
  // Ahead of the rate limiter on purpose, too. A desktop-managed refusal is a
  // fixed fact about this deployment, not a burst of work to shed. Behind the
  // limiter, a person tapping Restart four times got "Too many admin requests"
  // for five minutes instead of the explanation that tells them what to do.
  router.use('*', async (c, next) => {
    if (env.DORKOS_MANAGED_BY !== 'desktop') return next();
    const routerPath = c.req.path.slice(ADMIN_MOUNT.length) || '/';
    return problem(c, 'managed_by_desktop', { detail: desktopManagedMessage(routerPath) });
  });

  // Keys through the shared `rateLimitKey` — the TCP peer address, not the
  // spoofable `X-Forwarded-For` (DOR-1711). Three attempts per five minutes on routes that end the process
  // and can delete the data directory is a budget worth being able to reach.
  //
  // Attached per route rather than to the whole mount, because the two kinds of
  // request here cost different things. `adminLimiter` is ONE instance shared by
  // `/reset` and `/restart`, so the budget for ending this process is exactly
  // what it always was: three in five minutes, counted across both.
  //
  // A reset REFUSED for want of a token costs nothing, though. Counted, three
  // blind POSTs would spend the whole budget and lock the operator out of
  // Restart for five minutes — an attack that failed and denied service anyway.
  // `countsWhen` gives back the count when the response says
  // no, and that predicate is narrowed to this router's only 403, the
  // missing/expired/spent-token refusal. Everything else — the 200s that really
  // do end this process, the 400 on a bad `confirm` — still counts, so the
  // ceiling on acting is unchanged.
  const adminLimiter = honoRateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    limit: 3,
    headers: 'legacy',
    message: TOO_MANY_ADMIN_REQUESTS,
    countsWhen: (c) => c.res.status !== 403,
  });

  // Arming a reset changes nothing and deletes nothing, so it is not spent from
  // the acting budget — a person who starts a reset, cancels, and starts again
  // would otherwise have burned the requests they need to finish one. It is
  // limited on its own so a flood of mints cannot become free work, and it keys
  // through `rateLimitKey` like every other limiter here: a bucket a header can
  // move is not a bucket (DOR-1711).
  const prepareLimiter = honoRateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    limit: 10,
    headers: 'legacy',
    message: TOO_MANY_ADMIN_REQUESTS,
  });

  const resetTokens = new ResetTokenStore();

  /**
   * `POST /api/admin/reset/prepare` — hand out the one-time token `POST /reset`
   * demands. See {@link createAdminRoutes} for what this does and does not buy.
   */
  router.post('/reset/prepare', prepareLimiter, (c) => {
    const refused = refuseResetAway(c);
    return refused ?? c.json(resetTokens.mint(), 200);
  });

  router.post('/reset', adminLimiter, (c) => {
    const refused = refuseResetAway(c);
    if (refused) return refused;
    const { confirm, token } = readJsonBody(c, { emptyAs: {} }) as {
      confirm?: unknown;
      token?: unknown;
    };
    if (confirm !== 'reset') {
      return problem(c, 'invalid_request', {
        detail: 'Send { confirm: "reset" } to reset DorkOS.',
      });
    }

    // Checked BEFORE anything is torn down, and it is the last word: no branch
    // below this reaches `fs.rm` without a token that was minted, unexpired, and
    // unspent.
    if (!resetTokens.consume(token)) {
      return problem(c, 'forbidden', { detail: RESET_TOKEN_REQUIRED_MESSAGE });
    }

    setImmediate(async () => {
      try {
        await deps.shutdownServices('authority');
        deps.closeDb();
        await fs.rm(deps.dorkHome, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; restart regardless
      }
      triggerRestart();
    });
    // Queued above, so it runs after this answer has been written.
    return c.json({ message: 'Reset initiated. Server will restart.' }, 200);
  });

  router.post('/restart', adminLimiter, (c) => {
    setImmediate(async () => {
      try {
        await deps.shutdownServices();
      } catch {
        // Best-effort teardown; restart regardless
      }
      triggerRestart();
    });
    return c.json({ message: 'Restart initiated.' }, 200);
  });

  return router;
}
