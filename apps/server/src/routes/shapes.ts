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
 * because it writes files, rewrites config, and creates and deletes scheduled
 * work. `fork` does not: it copies a manifest into
 * `{dorkHome}/shapes/<name>/` and nothing else — no schedule, no extension, no
 * permission mode, and the copy is inert until somebody applies it, which is the
 * gated step. `GET /` reads. Said explicitly so the asymmetry reads as a decision
 * rather than an omission.
 *
 * @module routes/shapes
 */
import { Hono, type Context } from 'hono';
import { ZodError } from 'zod';
import { ForkShapeRequestSchema } from '@dorkos/shared/schemas';
import { validationFailureBody } from '../lib/route-utils.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
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

/** Constructor dependencies for {@link createShapesRoutes}. */
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
 * (`{dorkHome}/shapes/<name>/...`), and route params arrive URL-decoded, so a
 * crafted `..%2F..%2Fsecret` segment reaches the handler as `../../secret`.
 * Every handler that takes a `:name` rejects non-slug values with a 400 before
 * any resolution; a well-formed-but-absent name still 404s as before.
 */
const SHAPE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Validate a `:name` route param (or a fork target name) as a Shape slug.
 *
 * @param c - The request, for building the 400.
 * @param name - The raw, URL-decoded name to validate.
 * @returns The 400 to answer with when malformed, or `null` when it is a slug.
 */
function refuseNonSlug(c: Context<ApiEnv>, name: string): Response | null {
  if (SHAPE_NAME_RE.test(name)) return null;
  return c.json(
    { error: `Invalid Shape name '${name}' — must be a kebab-case slug (a-z, 0-9, -)` },
    400
  );
}

/**
 * Applying a Shape, as the permission gate sees it (DOR-625).
 *
 * ## Why `destructive`
 *
 * "Restore my layout" is what the name suggests, and the chrome half really is
 * cosmetic. The rest is not.
 *
 * **The argument is CREATION, not deletion.** `applyShape` writes a `SKILL.md`
 * into the operator's own skills root for every schedule the Shape declares,
 * records a write receipt naming what it wrote, rewrites `ui.shapes.active` in
 * `~/.dork/config.json`, and turns extensions on and off. Each of those is a
 * standing change to somebody's machine that outlives the call, and the moment to
 * look at it is the moment it is made — the same grounds on which
 * `gate-bypass-scan.test.ts` already protects `createTask(`.
 *
 * **What the argument is NOT, since DOR-607 and DOR-1486.** It is not that one
 * call arms unattended execution with the prompts off. It cannot:
 * `clampSchedulePermissionMode` downgrades a manifest's `bypassPermissions` to
 * `acceptEdits` before the row is written, a schedule is created enabled only when
 * the manifest set `startEnabled` AND its agent already exists, and the row lands
 * through `upsertFromFile({ source: 'discovery' })`, which
 * `resolveFileArmStatus` parks at `pending_approval` on first sighting. The tier
 * stands on the writing and rewiring, which is enough on its own.
 *
 * The deletion half — step 4b removes schedules carrying this Shape's provenance
 * that the current manifest no longer declares — is deliberately NOT the load-
 * bearing reason, because that argument loses to a counter-precedent already in
 * the tree: `memory_write` can remove the caller's own notes, is tier `act`, and
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
  // No permission area yet: the tier alone gates it (spec `agent-permissions`
  // assigns areas to everything else in phase 3), so it resolves no permission.
  area: null,
  // The Shape name is the whole decision: it names the manifest whose schedules,
  // permission modes, and extensions are about to be applied.
  approvalDisplayFields: ['name'],
};

/**
 * The Shapes routes.
 *
 * @param deps - Injected data directory + apply/fork collaborators.
 * @returns The routes, for `app.route('/api/shapes', …)`.
 */
export function createShapesRoutes(deps: ShapesRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  /**
   * Run the tier gate for the apply this route is about to perform itself.
   *
   * Deliberately the same sequence `routes/marketplace/context.ts` uses, in the same
   * order, so the two cannot drift in what they accept: read the caller's
   * authority once through the shared reader, mint a trusted marker if it is a
   * person, otherwise attribute the call to whatever agent identity resolved and
   * let the tier decide.
   *
   * @param c - The request, for its headers and the session gate's resolved user.
   * @param name - The Shape being applied; the approval binds to this value.
   * @returns What the gate decided. Proceed only on `allowed`.
   */
  const authorizeApply = (c: Context<ApiEnv>, name: string): TierEnforcementDecision => {
    const facts = honoRequestFacts(c);
    const identity = facts.agentIdentity;
    const header = facts.headers[APPROVAL_TOKEN_HEADER];
    const approvalToken = (Array.isArray(header) ? header[0] : header)?.trim();
    // A caller that may DECIDE an approval may act without one — the same
    // reasoning, and the same predicate, as every other route that skips the gate
    // for the person in the cockpit (see `capabilities/trusted-caller.ts`).
    if (trustedCaller(readCallerAuthority(facts))) return { outcome: 'allowed' };
    return enforceCapabilityTier({
      action: APPLY_SHAPE_ACTION,
      input: { name },
      // `APPLY_SHAPE_ACTION.area` is null, so there is no permission to resolve.
      permission: null,
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
   * @param c - The request being answered.
   * @param decision - The refusing decision to render.
   * @returns The response.
   */
  const gateResponse = (
    c: Context<ApiEnv>,
    decision: Exclude<TierEnforcementDecision, { outcome: 'allowed' }>
  ): Response => c.json(decision.payload, decision.outcome === 'approval_required' ? 202 : 403);

  // GET /api/shapes — installed Shapes, active flag resolved from config.
  router.get('/', async (c) => {
    const active = deps.applyDeps.configStore.getShapePrefs().active;
    const shapes = await listInstalledShapes(deps.dorkHome, active);
    return c.json({ shapes });
  });

  // POST /api/shapes/:name/apply — apply a Shape. Only "not installed" is fatal.
  router.post('/:name/apply', async (c) => {
    const name = c.req.param('name');
    const malformed = refuseNonSlug(c, name);
    if (malformed) return malformed;
    // Gated BEFORE the Shape is resolved, so a refused caller learns nothing about
    // what is installed and no collaborator is touched (DOR-625).
    const decision = authorizeApply(c, name);
    if (decision.outcome !== 'allowed') return gateResponse(c, decision);
    try {
      const result = await applyShape(name, deps.applyDeps);
      return c.json(result);
    } catch (err) {
      if (err instanceof ShapeNotInstalledError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  // POST /api/shapes/:name/fork — fork a Shape.
  router.post('/:name/fork', async (c) => {
    const name = c.req.param('name');
    const malformed = refuseNonSlug(c, name);
    if (malformed) return malformed;
    // An empty POST has no body at all; every field is optional, so default to
    // `{}` (fork with all defaults).
    const parsed = ForkShapeRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) return c.json(validationFailureBody(parsed.error), 400);
    const body = parsed.data;
    // A malformed target name is a client error (400), not a conflict (409) —
    // the fork service's own slug check stays as defense in depth.
    const malformedTarget = body.as === undefined ? null : refuseNonSlug(c, body.as);
    if (malformedTarget) return malformedTarget;
    try {
      const result = await forkShape(name, body, deps.forkDeps);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof ShapeNotInstalledError) {
        return c.json({ error: err.message }, 404);
      }
      if (err instanceof ShapeForkConflictError) {
        return c.json({ error: err.message }, 409);
      }
      // Belt: the fork re-validates the forked manifest through the marketplace
      // union. A refused manifest is a client-visible input problem, not a
      // server fault — surface it as a 400.
      if (err instanceof ZodError) {
        return c.json({ error: `Forked manifest failed validation: ${err.message}` }, 400);
      }
      throw err;
    }
  });

  return router;
}
