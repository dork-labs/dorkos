/**
 * The two agent-file routes for one project: `GET /api/harness/status`, which
 * reads and never writes, and `POST /api/harness/sync`, which is the Sync now
 * button (spec `harness-sync-status` §2.1 and §2.2).
 *
 * Everything from here down to "What the sync does" is about the GET alone.
 *
 * ## The GET never writes
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
 * ## The one field the model does not compute
 *
 * `claudeOnly` — the plugins a person turned on in Claude Code's own settings —
 * is added HERE, after {@link buildHarnessStatus} has answered, and that split is
 * deliberate. The status model is a pure function of the inputs it is handed and
 * resolves nothing for itself; reading a HOME directory is not an input a caller
 * can hand it, and putting the read inside would give the model a fact it could
 * not be tested against without a home directory. The server is where that root
 * is resolved, so the route asks for it and merges the answer in. `claudeOnly`
 * is therefore optional on the wire: the surfaces that cannot read a machine —
 * the Obsidian transport, which answers `state: 'unavailable'` — simply omit it.
 *
 * The read is TOTAL: an absent, unreadable or malformed settings file comes back
 * as the field's own `unreadable` record and never as a `500`. Losing a whole
 * project's status answer over a file in somebody's home directory would be the
 * wrong trade by a wide margin, and the record says so in words the caller can
 * render.
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
 * ## What the sync does, and what it says first
 *
 * `POST /api/harness/sync` applies the projection plan through
 * `projectWithConsent` — the one seam, never the engine's bare `project()` —
 * and answers with the recomputed status. Four things about it are decisions
 * rather than details:
 *
 * - **It sweeps** (`sweepOrphans: true`), and never silently. A button is the
 *   full-plan case, and half of what the banner reports is orphaned links, so a
 *   sync that did not sweep would leave the banner up after the click. It is
 *   safe because the engine only removes what it can prove it wrote (the
 *   `.dorkos-generated` sidecar, DOR-1842), and honest because the GET's
 *   `sweepPreview` names every path BEFORE the click and `swept` names them
 *   after — each with the reason it went (DOR-1906), the same sentence the
 *   terminal prints.
 * - **A person, not an agent.** {@link resolveDecisionAuthority} rather than
 *   `trustedCaller`: this wants the agent bar — refuse anything naming itself an
 *   agent or holding an approval token — and not the cookie requirement DOR-474
 *   put inside `trustedCaller`, which would lock out a person's own terminal
 *   (DOR-502). The GET carries no such bar, because it is a read of names and
 *   reasons anybody with a shell can already print.
 * - **A project with no manifest is `409`, not `200` and not `500`.**
 *   `loadManifest` throws `ENOENT` there, so the route probes for the manifest
 *   before it reaches the seam. A sync against a project that syncs nothing is
 *   not a success with zero work done, and the page never offers the button in
 *   that state, so the code is only reachable by a caller that ignored the
 *   status.
 * - **It does not wait for the approval cards.** A package whose hooks nobody
 *   has allowed gets a card, and answering one can take hours; a button that
 *   hangs on a modal is worse than one that returns and says what is waiting.
 *   The response carries `askedAbout` and the status carries `pendingApproval`,
 *   and the page learns that pass two finished from `approval_resolved`.
 *
 * **Concurrency.** The apply and the status read that follows it run in one
 * {@link withProjectLock} turn, so the status describes the tree this apply
 * left rather than one a watcher (DOR-1850) or a marketplace install rewrote in
 * between. A POST arriving while somebody else holds that repository's turn
 * queues, and still answers `200` with the recomputed status. The asking runs
 * OUTSIDE the turn deliberately: the lock is not re-entrant, and holding a
 * repository across an approval window would make one unanswered card block
 * every other projection into it.
 *
 * **The capability tier, recorded so it is not re-litigated.** This is not a
 * registered capability in v1 — no agent caller needs it, since an install
 * already projects through `runAutoProjection` — and if it is ever surfaced to
 * agents it is `act`, never `destructive`. `destructive` would put an approval
 * card in front of every routine re-sync, the harm DOR-504 and DOR-506 refused
 * twice; the card that matters is already on the CONTENT, and the sweep
 * disclosure is the mitigation a card would otherwise stand in for.
 *
 * @module routes/harness
 */
import { Router, type Response } from 'express';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { HARNESS_MANIFEST_PATH } from '@dorkos/harness';
import { HarnessStatusQuerySchema, HarnessSyncBodySchema } from '@dorkos/shared/harness-schemas';
import { BoundaryError, validateBoundaryOrDorkHome } from '../lib/boundary.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import { logger } from '../lib/logger.js';
import { resolveDecisionAuthority } from '../services/core/approvals/index.js';
import {
  askAboutWithheldHooks,
  hookPackagesToAskAbout,
} from '../services/harness/ask-withheld-hooks.js';
import type { HookApprovalGateway } from '../services/harness/hook-approval.js';
import { storedHookDecisions, type HookDecisions } from '../services/harness/hook-consent.js';
import { collectClaudeOnlyPlugins } from '../services/harness/claude-enabled-plugins.js';
import { projectWithConsent, withProjectLock } from '../services/harness/project-with-consent.js';
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
 * because `@dorkos/shared/harness-schemas` is what the CLIENT is built to import — that is
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

/**
 * The sync body, with the same absolute-path rule bolted on for the same reason
 * as {@link HarnessStatusQuery}: `isAbsolute` is `node:path`, whose answer is
 * platform-dependent, and the browser-safe schema module cannot ask it.
 */
const HarnessSyncBody = HarnessSyncBodySchema.refine(({ projectPath }) => isAbsolute(projectPath), {
  path: ['projectPath'],
  error: 'projectPath must be an absolute path',
});

/** Machine-readable refusal code when something that is not a person calls the sync. */
export const HARNESS_SYNC_OPERATOR_ONLY_CODE = 'operator_only_harness_sync';

/** Machine-readable refusal code for a sync against a project with no manifest. */
export const HARNESS_NOT_SET_UP_CODE = 'harness_not_set_up';

/** What the harness router reads, and — for the sync alone — writes through. */
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
  /**
   * The approval primitive the sync asks through, when a package's hooks are
   * waiting on somebody.
   *
   * Optional because a build without one must still project skills and commands
   * — but its absence FAILS CLOSED, exactly as `runAutoProjection`'s does: with
   * nobody to ask, hooks a person has not already allowed simply do not project,
   * `askedAbout` is empty, and the status still reports them as pending.
   */
  approvals?: HookApprovalGateway;
}

/**
 * Build the harness router.
 *
 * @param deps - The data directory, the hook-decision reader, and the approval
 *   primitive the sync asks through.
 * @returns A router serving `GET /status` and `POST /sync`.
 */
export function createHarnessRouter(deps: HarnessRouterDeps): Router {
  const router = Router();
  const readHookDecisions = deps.readHookDecisions ?? storedHookDecisions;

  /**
   * Resolve a caller-supplied project path to one this router may answer about,
   * or answer the refusal itself.
   *
   * Shared by both routes, because "which directory is this really, and may the
   * caller see it" is one question and two answers to it would be one of them
   * wrong. Every branch matches the module doc: a null byte is `400`, anything
   * else the boundary refuses is `403`, an absent directory is `404`, a
   * non-directory is `400`.
   *
   * @param projectPath - the absolute path the caller sent.
   * @param res - the response, answered directly on a refusal.
   * @param where - the route name, for the log lines.
   * @returns the canonical path, or `undefined` when `res` has been answered.
   */
  async function resolveProject(
    projectPath: string,
    res: Response,
    where: string
  ): Promise<string | undefined> {
    let resolved: string;
    try {
      resolved = await validateBoundaryOrDorkHome(projectPath);
    } catch (err: unknown) {
      if (err instanceof BoundaryError) {
        if (err.code === 'NULL_BYTE') {
          res.status(400).json({ error: err.message, code: err.code });
          return undefined;
        }
        res.status(403).json({ error: err.message, code: err.code });
        return undefined;
      }
      logger.error(`[harness] ${where} boundary check failed`, { err, projectPath });
      res.status(500).json({ error: 'Internal server error' });
      return undefined;
    }

    // The absent-project case the status model hands back (see the module doc).
    try {
      if (!(await stat(resolved)).isDirectory()) {
        res.status(400).json({ error: 'Not a directory' });
        return undefined;
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        res.status(404).json({ error: 'Project directory not found' });
        return undefined;
      }
      if (code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' });
        return undefined;
      }
      logger.error(`[harness] ${where} could not read the project directory`, {
        err,
        projectPath: resolved,
      });
      res.status(500).json({ error: 'Internal server error' });
      return undefined;
    }

    return resolved;
  }

  // GET /api/harness/status?projectPath=<absolute path>
  router.get('/status', async (req, res) => {
    const parsed = HarnessStatusQuery.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
    }
    const resolved = await resolveProject(parsed.data.projectPath, res, 'GET /status');
    if (resolved === undefined) return;

    try {
      // Sent as-is apart from `claudeOnly`: the response IS the status model,
      // and a route that reshaped it would be a second voice describing one
      // tree. The one addition is the field the model cannot compute, for the
      // reason the module doc gives.
      const status = buildHarnessStatus({
        projectPath: resolved,
        dorkHome: deps.dorkHome,
        decisions: readHookDecisions(),
      });
      const claudeOnly = await collectClaudeOnlyPlugins({
        projectPath: resolved,
        dorkHome: deps.dorkHome,
      });
      return res.json({ ...status, claudeOnly });
    } catch (err: unknown) {
      // Logged, not echoed: the engine's message can name a path the caller did
      // not send, and every state a person can act on is already a 200.
      logger.error('[harness] GET /status failed', { err, projectPath: resolved });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/harness/sync  { projectPath: <absolute path> }
  router.post('/sync', async (req, res) => {
    // Ahead of validation on purpose, the order `POST /api/marketplace/sources`
    // uses: a caller that may not do this at all gets one answer whatever it
    // sent, rather than a schema it can probe.
    if (!resolveDecisionAuthority(readCallerAuthority(req, res)).allowed) {
      return res.status(403).json({
        error: 'Only a person can sync agent files',
        code: HARNESS_SYNC_OPERATOR_ONLY_CODE,
        message:
          'This writes into your project and removes files DorkOS put there, so it is a ' +
          'decision a person makes in DorkOS rather than something an agent does on your behalf.',
      });
    }

    const parsed = HarnessSyncBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: z.treeifyError(parsed.error) });
    }

    const resolved = await resolveProject(parsed.data.projectPath, res, 'POST /sync');
    if (resolved === undefined) return;

    // Before the seam, because `loadManifest` throws ENOENT there and a project
    // with nothing set up is not a sync that did no work.
    if (!existsSync(join(resolved, HARNESS_MANIFEST_PATH))) {
      return res.status(409).json({
        error: 'DorkOS isn’t sharing agent files for this folder yet',
        code: HARNESS_NOT_SET_UP_CODE,
        message: 'Run `dorkos harness sync --fix` in this folder to set it up.',
      });
    }

    try {
      // The apply and the read it answers with are ONE turn: a status recomputed
      // outside the lock could describe a tree somebody else rewrote in between,
      // which is the one thing this response is supposed to be authoritative
      // about. `sweepOrphans: true` is safe here because this plan takes no
      // harness filter — the seam throws if the two are ever combined.
      const { result, status } = await withProjectLock(resolved, () => {
        const applied = projectWithConsent(resolved, {
          dorkHome: deps.dorkHome,
          sweepOrphans: true,
          decisions: readHookDecisions(),
        });
        return {
          result: applied,
          status: buildHarnessStatus({
            projectPath: resolved,
            dorkHome: deps.dorkHome,
            decisions: readHookDecisions(),
            // The only place a blocked target is discovered is the write that
            // hit it, so the recomputed status is told what this one ran into.
            afterWrite: { conflicts: applied.conflicts },
          }),
        };
      });

      // OUTSIDE the turn, and never awaited. The lock is not re-entrant, so the
      // second pass has to take its own; and a card can sit unanswered for hours,
      // which is a response that never arrives and a repository nothing else can
      // project into. What the person is told meanwhile is `askedAbout` here and
      // `pendingApproval` on the status, and the page re-reads on
      // `approval_resolved` when pass two has actually run.
      const gateway = deps.approvals;
      const askedAbout =
        gateway === undefined
          ? []
          : hookPackagesToAskAbout(result.withheld).map(({ packageName }) => packageName);
      if (gateway !== undefined && askedAbout.length > 0) {
        void askAboutWithheldHooks(result.withheld, {
          projectPath: resolved,
          approvals: gateway,
          reproject: () => {
            void withProjectLock(resolved, () =>
              projectWithConsent(resolved, {
                dorkHome: deps.dorkHome,
                // The same sweep decision as pass one: a second pass that did not
                // sweep would leave behind exactly what the first one removed.
                sweepOrphans: true,
                decisions: readHookDecisions(),
              })
            ).catch((err: unknown) => {
              logger.warn('[harness] POST /sync could not re-project after an approval', {
                err,
                projectPath: resolved,
              });
            });
          },
        }).catch((err: unknown) => {
          logger.warn('[harness] POST /sync could not ask about a package’s hooks', {
            err,
            projectPath: resolved,
          });
        });
      }

      return res.json({
        status,
        applied: result.applied.length,
        swept: result.swept,
        // The paths again, each with the sentence saying why it went (DOR-1906).
        // The page draws these; a list of deleted files with no reasons is the
        // failure this whole slice exists to prevent.
        removals: result.removals,
        conflicts: result.conflicts.length,
        askedAbout,
      });
    } catch (err: unknown) {
      // Logged, not echoed, for the reason the GET gives: the engine's message
      // can name a path the caller never sent.
      logger.error('[harness] POST /sync failed', { err, projectPath: resolved });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
