/**
 * One app calling another's server routes (DOR-3293, Security 2026-11-10).
 *
 * Both sides must agree, and both say so in their manifests:
 *
 * - **The caller** lists the exact apps it calls, in `capabilities.http.apps`.
 *   It works one way only: listing an app gives that app nothing back.
 * - **The target** lists each route it lets other apps call, in
 *   `exports.http`. Nothing is exported by default. A `GET` is the normal case;
 *   a write needs its own entry in `methods`, and `callers` can narrow a route
 *   to named apps. A route the target marks `personOnly` is never exported:
 *   it only answers the target's own screens.
 *
 * One pure decision ({@link decideAppCall}), used by both the host bridge in
 * the person's window and the server in front of the target's routes, so the
 * two can never disagree about what is allowed.
 *
 * @module extension-api/cross-app
 */
import { z } from 'zod';
import { EXTENSION_ID_REGEX } from '@dorkos/shared/extension-id';

/** The methods an app route answers. */
export const APP_ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** One method an app route answers. */
export type AppRouteMethod = (typeof APP_ROUTE_METHODS)[number];

/** The most apps one app may call. */
export const MAX_CALLED_APPS = 20;

/**
 * A route pattern: `/` then segments, each a literal (`items`, `q3.v2`) or a
 * placeholder for exactly one segment (`:id`). No wildcards, and never a
 * `.` or `..` segment, so an export names each shape of path it lets in.
 */
const ROUTE_PATTERN_REGEX =
  /^\/(?:(?:(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9]*)(?:\/|$))*$/;

const AppIdSchema = z.string().min(1).max(120).regex(EXTENSION_ID_REGEX);

const RoutePatternSchema = z
  .string()
  .max(400)
  .regex(ROUTE_PATTERN_REGEX, 'Use a path like /items or /items/:id');

/** One route a target lets other apps call. */
export const AppExportRouteSchema = z
  .object({
    /** The route, e.g. `/briefs` or `/briefs/:id`. */
    path: RoutePatternSchema,
    /** What other apps may do there. A write needs its own entry. */
    methods: z
      .array(z.enum(APP_ROUTE_METHODS))
      .min(1)
      .refine((methods) => new Set(methods).size === methods.length, 'List each method once'),
    /** Only these apps may call it. Leave it out to let any app that lists this one call it. */
    callers: z.array(AppIdSchema).min(1).optional(),
  })
  .strict();

/** What a target lets other apps reach. */
export const ExtensionExportsSchema = z
  .object({
    /** Routes other apps may call. Nothing is exported unless it is listed here. */
    http: z.array(AppExportRouteSchema).max(100).optional(),
    /**
     * Routes only this app's own screens may call, e.g. `/approve`. Never
     * exported, whatever `http` says.
     */
    personOnly: z.array(RoutePatternSchema).max(100).optional(),
  })
  .strict();

/** `capabilities.http`: `true` for this app's own routes, or the apps it also calls. */
export const HttpCapabilitySchema = z.union([
  z.boolean(),
  z
    .object({
      /** Exact ids of the apps this one calls. */
      apps: z.array(AppIdSchema).max(MAX_CALLED_APPS),
    })
    .strict(),
]);

/** One route a target lets other apps call. */
export type AppExportRoute = z.infer<typeof AppExportRouteSchema>;
/** What a target lets other apps reach. */
export type ExtensionExports = z.infer<typeof ExtensionExportsSchema>;

/** The parts of a manifest a cross-app decision reads. */
export interface CrossAppManifest {
  id: string;
  capabilities?: { http?: boolean | { apps: string[] } };
  exports?: ExtensionExports;
}

/**
 * The apps a manifest says it calls, in the order it lists them.
 *
 * @param manifest - The caller's manifest.
 */
export function calledApps(manifest: Pick<CrossAppManifest, 'capabilities'>): string[] {
  const http = manifest.capabilities?.http;
  return typeof http === 'object' ? [...new Set(http.apps)] : [];
}

/** Split a path into its segments, without the query. */
function segmentsOf(path: string): string[] {
  const query = path.indexOf('?');
  return (query === -1 ? path : path.slice(0, query)).slice(1).split('/');
}

/**
 * Whether a path fits a route pattern. A placeholder matches exactly one
 * non-empty segment; a literal matches only itself.
 *
 * @param pattern - The route pattern, e.g. `/briefs/:id`.
 * @param path - The path the caller asked for, its segments already decoded.
 */
export function routeMatches(pattern: string, path: string): boolean {
  const want = segmentsOf(pattern);
  const have = segmentsOf(path);
  if (want.length !== have.length) return false;
  return want.every((segment, i) =>
    segment.startsWith(':') ? have[i] !== '' : segment === have[i]
  );
}

/** Whether two route patterns can match the same path. */
export function routesOverlap(a: string, b: string): boolean {
  const left = segmentsOf(a);
  const right = segmentsOf(b);
  if (left.length !== right.length) return false;
  return left.every(
    (segment, i) => segment === right[i] || segment.startsWith(':') || right[i]!.startsWith(':')
  );
}

/** Why a call from one app to another was refused. */
export type AppCallRefusal =
  | 'not-declared'
  | 'self'
  | 'target-unavailable'
  | 'person-only'
  | 'not-exported'
  | 'method-not-exported'
  | 'caller-not-listed';

/** The answer to one cross-app call: allowed, or refused and why. */
export type AppCallDecision = { ok: true } | { ok: false; reason: AppCallRefusal };

/**
 * Decide one call from one app to another app's server route.
 *
 * Both manifests come from DorkOS's own records, never from either app. A
 * target that is not installed, or not running, is passed as `null`.
 *
 * @param input - The caller, the target, and what was asked for.
 * @returns Allowed, or the reason it was refused.
 */
export function decideAppCall(input: {
  caller: CrossAppManifest;
  target: CrossAppManifest | null;
  targetId: string;
  method: AppRouteMethod;
  path: string;
}): AppCallDecision {
  const { caller, target, targetId, method, path } = input;
  if (targetId === caller.id) return { ok: false, reason: 'self' };
  if (!calledApps(caller).includes(targetId)) return { ok: false, reason: 'not-declared' };
  if (!target || target.id !== targetId) return { ok: false, reason: 'target-unavailable' };
  const exports = target.exports;
  if ((exports?.personOnly ?? []).some((pattern) => routeMatches(pattern, path))) {
    return { ok: false, reason: 'person-only' };
  }
  const routes = (exports?.http ?? []).filter((route) => routeMatches(route.path, path));
  if (routes.length === 0) return { ok: false, reason: 'not-exported' };
  const open = routes.filter((route) => route.methods.includes(method));
  if (open.length === 0) return { ok: false, reason: 'method-not-exported' };
  if (!open.some((route) => !route.callers || route.callers.includes(caller.id))) {
    return { ok: false, reason: 'caller-not-listed' };
  }
  return { ok: true };
}

/**
 * What a target lets this caller do, for the line on its approval card:
 * `reads`, `changes` (writes only), `both`, or `null` when it exports nothing
 * to this caller. Read from the target's exports, never from the caller.
 *
 * @param target - The target's manifest.
 * @param callerId - The app asking.
 */
export function exportedAccess(
  target: Pick<CrossAppManifest, 'exports'>,
  callerId: string
): 'reads' | 'changes' | 'both' | null {
  const personOnly = target.exports?.personOnly ?? [];
  const routes = (target.exports?.http ?? []).filter(
    (route) =>
      (!route.callers || route.callers.includes(callerId)) &&
      !personOnly.some((pattern) => routesOverlap(pattern, route.path))
  );
  const reads = routes.some((route) => route.methods.includes('GET'));
  const changes = routes.some((route) => route.methods.some((method) => method !== 'GET'));
  if (reads && changes) return 'both';
  if (reads) return 'reads';
  return changes ? 'changes' : null;
}

/**
 * The manifest checks that span fields: an export never overlaps a
 * `personOnly` route, and an app never lists itself as an app it calls.
 *
 * @param manifest - The manifest's parsed fields.
 * @param ctx - Where each issue is added.
 */
export function checkCrossAppDeclarations(manifest: CrossAppManifest, ctx: z.RefinementCtx): void {
  calledApps(manifest).forEach((id) => {
    if (id === manifest.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', 'http', 'apps'],
        message: 'An app does not list itself; its own routes need only `http: true`',
      });
    }
  });
  const personOnly = manifest.exports?.personOnly ?? [];
  (manifest.exports?.http ?? []).forEach((route, index) => {
    const clash = personOnly.find((pattern) => routesOverlap(pattern, route.path));
    if (clash) {
      ctx.addIssue({
        code: 'custom',
        path: ['exports', 'http', index, 'path'],
        message: `"${route.path}" overlaps the personOnly route "${clash}", which is never exported`,
      });
    }
  });
}
