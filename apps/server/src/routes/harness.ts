/**
 * `GET /api/harness/status` — what every agent tool does with every agent file
 * in one project, read and never written (spec `harness-sync-status` §2.1).
 *
 * ## This route never writes
 *
 * `dorkos harness sync --check` learned this the hard way (DOR-678, contract
 * AP-03): run in a folder with no manifest, it quietly scaffolded one into
 * whatever directory the person was standing in. Three things are therefore
 * deliberately not done here:
 *
 * - **No `scaffoldManifest`.** A project with no manifest answers
 *   `state: 'not-set-up'`.
 * - **No `enableHarnessInManifest`.** The not-enabled notice is copy.
 * - **No store creation.** This runs inside the server, whose `conf` store is
 *   already open, so {@link storedHookDecisions} is the correct reader and
 *   writes nothing. `readHookDecisionsFromDisk` exists for the CLI, a separate
 *   process where opening the store would create the file; that is DOR-678's
 *   rule and it does not transfer to the server. Stated because "never open the
 *   config store" reads like it should.
 *
 * ## What it answers
 *
 * The response IS {@link buildHarnessStatus}'s status model, sent as-is — the
 * route reshapes nothing, so the page and the CLI can never describe one tree
 * two ways. Three of the model's four `state` values reach a caller here:
 * `ready`, `not-set-up` and `unreadable`. The fourth, `unavailable`, is never
 * produced by this route and never will be: it means a build with no harness
 * service at all, which is the Obsidian transport's answer rather than an HTTP
 * one, and `status.ts` says the same thing from the other side.
 *
 * **`not-set-up` is a `200`, not a `404`.** A `404` says the route is not there.
 * A project with no manifest is a project in a state the page is built to
 * render, and turning it into an error class makes every caller re-derive the
 * difference between "no such endpoint" and "nothing set up here".
 *
 * ## Failures that are still failures
 *
 * A missing, blank or relative `projectPath` is `400`; a path outside the
 * boundary is `403`; an unexpected throw is `500` with the message logged and
 * not echoed.
 *
 * **And a `projectPath` that leads nowhere is a `404`** — the case
 * {@link buildHarnessStatus} explicitly hands back to this route, because the
 * manifest read fails with `ENOENT` whether the project is empty or absent and
 * the model cannot tell them apart. The boundary validator does NOT settle it
 * either: {@link validateBoundaryOrDorkHome} canonicalizes a not-yet-existing
 * path through its deepest existing ancestor and RETURNS it (that is what lets
 * a workspace about to be cloned validate), so a typo inside the boundary
 * resolves happily and would have read as `not-set-up`. One `stat` after the
 * boundary check is what separates them, and it maps the two ways it can fail
 * exactly as `GET /api/directory` — this route's nearest neighbour on the same
 * validator — already maps them: absent is `404`, a path that is not a
 * directory is `400`.
 *
 * ## Why the wider boundary validator
 *
 * `validateBoundaryOrDorkHome`, not `validateBoundary`. The page's whole subject
 * is an agent, and a DorkOS-managed agent lives at `{dorkHome}/agents/<slug>` —
 * the exact subtree `validateBoundary` refuses, so using it would 403 the
 * surface this is built for. `boundary.ts`'s own rule admits read-only listing
 * to the wider validator because it is names only, no file contents and no
 * writes; this response carries artifact names, repo-relative paths and reasons
 * and never file bytes, so it sits on the listing side of that line.
 *
 * The GET carries no caller-authority bar. It is a read of names, paths and
 * reasons about a project the caller can already see — the same information
 * `dorkos harness sync --check` prints to anyone with a shell — and gating it
 * would make an agent unable to answer "what can you see?" about itself.
 *
 * ## What it costs, and why nothing guards it yet
 *
 * {@link buildHarnessStatus} is three SYNCHRONOUS filesystem walks — the plan,
 * the drift check, the source inventory — so for their whole duration this
 * request owns the event loop and every other request waits. Measured in
 * process against this repository (57 rows, three harnesses enabled): **median
 * 26 ms per call, range 23–34 ms**, and **ten calls back to back are 268 ms of
 * uninterrupted loop time**. Over HTTP on a machine already busy with other
 * work, ten concurrent GETs finished in 0.9–1.4 s and pushed an unrelated
 * `GET /api/health` p95 from about 9 ms to 44–162 ms.
 *
 * **No lock, no queue, no cache is added here, and that is deliberate.** The
 * shape of the load is what settles it: this answers one page, opened by one
 * person, for one project at a time — there is no fan-out and no poller. Slice 6
 * reaches it through a hook that reads the query cache and never fetches on
 * profile open, so the ordinary path costs nothing at all. A lock would turn a
 * slow read into a queue of slow reads; a cache would need invalidating on every
 * filesystem write any agent makes, which is a correctness problem traded for
 * 26 ms (the spec's Performance section reaches the same conclusion, with a
 * ≤ 150 ms budget this sits well inside). If a real repository is ever measured
 * past that budget, the answer is pagination or a summary-first response, with
 * the measurement attached — not a guard added on suspicion.
 *
 * @module routes/harness
 */
import { Router } from 'express';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { HarnessStatusQuerySchema } from '@dorkos/shared/harness-schemas';
import { BoundaryError, validateBoundaryOrDorkHome } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import { storedHookDecisions, type HookDecisions } from '../services/harness/hook-consent.js';
import { buildHarnessStatus } from '../services/harness/status.js';

/**
 * The shared query shape, plus the one rule that cannot live beside it.
 *
 * `projectPath` must be ABSOLUTE. Without this, a relative one is resolved
 * against the server's own `process.cwd()` — still boundary-checked, so nothing
 * escapes, but the answer describes a directory the caller never named, and
 * which one depends on where the operator happened to start the process.
 *
 * The check is bolted on HERE rather than added to `HarnessStatusQuerySchema`
 * because `@dorkos/shared/harness-schemas` is imported by the CLIENT — that is
 * why the harness vocabulary was moved down into it at all — and `isAbsolute` is
 * `node:path`, whose answer is platform-dependent (`C:\…` and `\\server\share`
 * are absolute on Windows and not on POSIX). Reimplementing it as a regex in a
 * browser-safe module would be a second, wrong copy of a platform question the
 * server can just ask. Nothing is lost in the generated docs: `zod-to-openapi`
 * projects no refinement, so the blankness rule beside it is invisible there
 * too, and the OpenAPI description states the requirement in words.
 */
const HarnessStatusQuery = HarnessStatusQuerySchema.refine(
  ({ projectPath }) => isAbsolute(projectPath),
  { path: ['projectPath'], error: 'projectPath must be an absolute path' }
);

/** What the harness router reads. It writes nothing and holds no state. */
export interface HarnessRouterDeps {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /**
   * Where the stored hook decisions come from. Defaults to
   * {@link storedHookDecisions} — the running server's already-open store, which
   * is the whole of the "no store creation" rule above.
   *
   * Injectable so a test can drive this route without a config store at all,
   * which is what makes the never-writes claim checkable: a route that reached
   * for the store itself would throw there rather than pass quietly.
   */
  readHookDecisions?: () => HookDecisions;
}

/**
 * Build the harness router.
 *
 * @param deps - The data directory and the hook-decision reader.
 * @returns A router serving `GET /status`.
 */
export function createHarnessRouter(deps: HarnessRouterDeps): Router {
  const router = Router();
  const readHookDecisions = deps.readHookDecisions ?? storedHookDecisions;

  // GET /api/harness/status?projectPath=<absolute path>
  router.get('/status', async (req, res) => {
    const parsed = HarnessStatusQuery.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
    }
    const { projectPath } = parsed.data;

    let resolved: string;
    try {
      resolved = await validateBoundaryOrDorkHome(projectPath);
    } catch (err: unknown) {
      if (err instanceof BoundaryError) {
        if (err.code === 'NULL_BYTE') {
          return res.status(400).json({ error: err.message, code: err.code });
        }
        return res.status(403).json({ error: err.message, code: err.code });
      }
      logger.error('[harness] GET /status boundary check failed', { err, projectPath });
      return res.status(500).json({ error: 'Internal server error' });
    }

    // The absent-project case the status model hands back (see the module doc).
    try {
      if (!(await stat(resolved)).isDirectory()) {
        return res.status(400).json({ error: 'Not a directory' });
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return res.status(404).json({ error: 'Project directory not found' });
      if (code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
      logger.error('[harness] GET /status could not read the project directory', {
        err,
        projectPath: resolved,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }

    try {
      // Sent as-is: the response IS the status model, and a route that reshaped
      // it would be a second voice describing one tree.
      return res.json(
        buildHarnessStatus({
          projectPath: resolved,
          dorkHome: deps.dorkHome,
          decisions: readHookDecisions(),
        })
      );
    } catch (err: unknown) {
      // Logged, not echoed: the engine's message can name a path the caller did
      // not send, and every state a person can act on is already a 200.
      logger.error('[harness] GET /status failed', { err, projectPath: resolved });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
