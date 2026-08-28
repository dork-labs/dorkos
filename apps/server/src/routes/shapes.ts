/**
 * Shape routes (DOR-355, spec §9) — list, apply, and fork installed Shapes.
 *
 * - `GET  /api/shapes` — installed Shapes (name, displayName, active flag, lineage).
 * - `POST /api/shapes/:name/apply` — apply a Shape; returns the exact §5 value
 *   `{ ok, applied, warnings[], offeredAgents[] }` so the client restores the
 *   chrome (`applied.layout`) without a second fetch.
 * - `POST /api/shapes/:name/fork` — fork a Shape (body
 *   `{ as?, captureCurrent?, liveLayout? }`). `liveLayout` is the client's
 *   partial chrome snapshot; the fork service merges it field-wise over the
 *   source Shape's layout.
 *
 * The router holds no I/O of its own — every collaborator is injected, so it is
 * driven with fakes in tests and the real singletons in `index.ts`.
 *
 * ## What is gated here, and what is not
 *
 * `apply` answers to the permission gate ({@link APPLY_SHAPE_ACTION}, DOR-625),
 * because it arms scheduled work. `fork` does not: it copies a manifest into
 * `{dorkHome}/shapes/<name>/` and nothing else — no schedule, no extension, no
 * permission mode, and the copy is inert until somebody applies it, which is the
 * gated step. `GET /` reads. Said explicitly so the asymmetry reads as a decision
 * rather than an omission.
 *
 * @module routes/shapes
 */
import { Router, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { ForkShapeRequestSchema } from '@dorkos/shared/schemas';
import { parseBody } from '../lib/route-utils.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import { getRequestAgentIdentity } from '../middleware/agent-identity.js';
import { APPROVAL_TOKEN_HEADER, trustedCaller } from '../services/core/capabilities/index.js';
import {
  enforceCapabilityTier,
  type GatedAction,
  type TierEnforcementDecision,
} from '../services/core/capabilities/tier-enforcement.js';
import {
  applyShape,
  ShapeNotInstalledError,
  type ApplyShapeDeps,
} from '../services/shapes/apply-shape.js';
import { forkShape, ShapeForkConflictError, type ForkShapeDeps } from '../services/shapes/fork.js';
import { listInstalledShapes } from '../services/shapes/shape-services.js';

/** Constructor dependencies for {@link createShapesRouter}. */
export interface ShapesRouterDeps {
  /** Resolved DorkOS data directory. */
  dorkHome: string;
  /** Injected collaborators for the apply flow. */
  applyDeps: ApplyShapeDeps;
  /** Injected collaborators for the fork flow. */
  forkDeps: ForkShapeDeps;
}

/**
 * Kebab-case Shape-name shape (mirrors the manifest `name` constraint).
 *
 * SECURITY: `:name` is interpolated into filesystem paths downstream
 * (`{dorkHome}/shapes/<name>/...`), and Express URL-decodes route params, so a
 * crafted `..%2F..%2Fsecret` segment reaches the handler as `../../secret`.
 * Every handler that takes a `:name` rejects non-slug values with a 400 before
 * any resolution; a well-formed-but-absent name still 404s as before.
 */
const SHAPE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Validate a `:name` route param (or a fork target name) as a Shape slug.
 * Writes the 400 response and returns `null` when malformed.
 *
 * @param name - The raw, URL-decoded name to validate.
 * @param res - Response used to emit the 400.
 * @returns The validated name, or `null` after a 400 was sent.
 */
function requireShapeSlug(name: string, res: Response): string | null {
  if (!SHAPE_NAME_RE.test(name)) {
    res.status(400).json({
      error: `Invalid Shape name '${name}' — must be a kebab-case slug (a-z, 0-9, -)`,
    });
    return null;
  }
  return name;
}

/**
 * Applying a Shape, as the permission gate sees it (DOR-625).
 *
 * ## Why `destructive`
 *
 * "Restore my layout" is what the name suggests, and the chrome half really is
 * cosmetic. The rest is not.
 *
 * **The argument is CREATION, not deletion.** `applyShape` creates every schedule
 * the Shape's manifest declares, ENABLED, each carrying the `permissionMode` that
 * manifest chose — and `SCHEDULE_PERMISSION_MODES` includes
 * `bypassPermissions`. One call therefore arms recurring, unattended execution on
 * the operator's machine with every safety prompt off, at a time nobody is
 * watching. That is the same thing `gate-bypass-scan.test.ts` already protects
 * `createTask(` for, and on the same grounds: a schedule is a standing grant that
 * fires later, so the moment to look at it is the moment it is created.
 *
 * The deletion half — step 4b removes schedules carrying this Shape's provenance
 * that the current manifest no longer declares — is deliberately NOT the load-
 * bearing reason, because that argument loses to a counter-precedent already in
 * the tree: `relay_inbox` permanently deletes the mail it acks, is tier `act`, and
 * is auto-allowed, justified precisely by being confined to the caller's own
 * things. Step 4b is provenance-gated in exactly that way (a user's own schedules
 * and other Shapes' are never touched), so on its own it would argue for `act`.
 * It is what the tier costs, not why the tier is right.
 *
 * The cost of the tier is bounded, which is why it is affordable: a person
 * clicking a Shape in their own cockpit sends no agent header, clears
 * `trustedCaller`, and skips the gate entirely. Nobody who was not already a
 * machine sees a card.
 *
 * ## Why a {@link GatedAction} and not a registry capability
 *
 * The marketplace routes reach this same gate through `authorizeCapability`,
 * which looks their effect up in the Capability Registry. Shapes is not a registry
 * domain, and declaring a `shapes.apply` capability purely so there is something
 * to look up would ADD an agent-invocable path — `POST
 * /api/capabilities/shapes.apply/invoke` and `dorkos call shapes.apply` — to the
 * exact effect this is closing. `GatedAction` is the shape the gate already
 * defines for an effect that is not a capability (see its TSDoc, and
 * `core/mcp-tool-gate.ts`, where all 47 hand-registered MCP tools reach the gate
 * the same way). Everything downstream is identical either way: the same decision
 * type, the same 202/403, the same `X-DorkOS-Approval` retry header.
 *
 * The id is dotted so it reads like the capability it would become if shapes ever
 * migrates. `__tests__/shapes.test.ts` ("reserves the shapes.apply id") asserts
 * against `composeCapabilityRegistryForDocs` — which composes every domain
 * unconditionally — that no capability claims this id, so a migration has to
 * reconcile the two rather than quietly create a second action sharing one
 * approval id space.
 */
export const APPLY_SHAPE_ACTION: GatedAction = {
  id: 'shapes.apply',
  title: 'Switch to a Shape',
  tier: 'destructive',
  // The Shape name is the whole decision: it names the manifest whose schedules,
  // permission modes, and extensions are about to be applied.
  approvalDisplayFields: ['name'],
};

/**
 * Create the Shapes router.
 *
 * @param deps - Injected data directory + apply/fork collaborators.
 * @returns An Express router mounted at `/api/shapes`.
 */
export function createShapesRouter(deps: ShapesRouterDeps): Router {
  const router = Router();

  /**
   * Run the tier gate for the apply this route is about to perform itself.
   *
   * Deliberately the same sequence `routes/marketplace.ts` uses, in the same
   * order, so the two cannot drift in what they accept: read the caller's
   * authority once through the shared reader, mint a trusted marker if it is a
   * person, otherwise attribute the call to whatever agent identity resolved and
   * let the tier decide.
   *
   * @param req - The incoming request.
   * @param res - The response, for `sessionGate`'s resolved user.
   * @param name - The Shape being applied; the approval binds to this value.
   * @returns What the gate decided. Proceed only on `allowed`.
   */
  const authorizeApply = (req: Request, res: Response, name: string): TierEnforcementDecision => {
    const identity = getRequestAgentIdentity(res);
    const header = req.headers[APPROVAL_TOKEN_HEADER];
    const approvalToken = (Array.isArray(header) ? header[0] : header)?.trim();
    // A caller that may DECIDE an approval may act without one — the same
    // reasoning, and the same predicate, as every other route that skips the gate
    // for the person in the cockpit (see `capabilities/trusted-caller.ts`).
    if (trustedCaller(readCallerAuthority(req, res))) return { outcome: 'allowed' };
    return enforceCapabilityTier({
      action: APPLY_SHAPE_ACTION,
      input: { name },
      ...(identity ? { identity } : {}),
      ...(approvalToken ? { approvalToken } : {}),
      retryChannel: 'http-header',
    });
  };

  /**
   * Turn a non-`allowed` gate decision into this router's HTTP answer: `202` when
   * a person has been asked and the caller should retry with the token, `403`
   * when no retry can change the answer.
   *
   * @param res - The response to write.
   * @param decision - The refusing decision to render.
   * @returns The sent response.
   */
  const gateResponse = (
    res: Response,
    decision: Exclude<TierEnforcementDecision, { outcome: 'allowed' }>
  ): Response =>
    res.status(decision.outcome === 'approval_required' ? 202 : 403).json(decision.payload);

  // GET /api/shapes — installed Shapes, active flag resolved from config.
  router.get('/', async (_req, res) => {
    const active = deps.applyDeps.configStore.getShapePrefs().active;
    const shapes = await listInstalledShapes(deps.dorkHome, active);
    res.json({ shapes });
  });

  // POST /api/shapes/:name/apply — apply a Shape. Only "not installed" is fatal.
  router.post('/:name/apply', async (req, res) => {
    const name = requireShapeSlug(req.params.name, res);
    if (!name) return;
    // Gated BEFORE the Shape is resolved, so a refused caller learns nothing about
    // what is installed and no collaborator is touched (DOR-625).
    const decision = authorizeApply(req, res, name);
    if (decision.outcome !== 'allowed') return gateResponse(res, decision);
    try {
      const result = await applyShape(name, deps.applyDeps);
      res.json(result);
    } catch (err) {
      if (err instanceof ShapeNotInstalledError) {
        return res.status(404).json({ error: err.message });
      }
      throw err;
    }
  });

  // POST /api/shapes/:name/fork — fork a Shape.
  router.post('/:name/fork', async (req, res) => {
    const name = requireShapeSlug(req.params.name, res);
    if (!name) return;
    // Express 5 leaves `req.body` undefined on an empty POST; every field is
    // optional, so default to `{}` (fork with all defaults).
    const body = parseBody(ForkShapeRequestSchema, req.body ?? {}, res);
    if (!body) return;
    // A malformed target name is a client error (400), not a conflict (409) —
    // the fork service's own slug check stays as defense in depth.
    if (body.as !== undefined && !requireShapeSlug(body.as, res)) return;
    try {
      const result = await forkShape(name, body, deps.forkDeps);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof ShapeNotInstalledError) {
        return res.status(404).json({ error: err.message });
      }
      if (err instanceof ShapeForkConflictError) {
        return res.status(409).json({ error: err.message });
      }
      // Belt: the fork re-validates the forked manifest through the marketplace
      // union. A refused manifest is a client-visible input problem, not a
      // server fault — surface it as a 400.
      if (err instanceof ZodError) {
        return res.status(400).json({ error: `Forked manifest failed validation: ${err.message}` });
      }
      throw err;
    }
  });

  return router;
}
