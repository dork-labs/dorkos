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
 *   it only answers the target's own screens. A `personOnly` rule is a path
 *   (every method there) or a path and its methods, so a read can be exported
 *   while a write on the same path stays the target's own.
 *
 * One pure decision ({@link decideAppCall}), used by both the host bridge in
 * the person's window and the server in front of the target's routes, so the
 * two can never disagree about what is allowed.
 *
 * Listing an app as `{ "id": …, "navigate": true }` also lets the caller send
 * the person to one of its pages ({@link decideAppNavigate}): by the item's
 * path alone, with no query, hash
 * or encoded character, so a link can say which item and nothing about what
 * to do with it. The page the person lands on decides what happens there.
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

/**
 * Another app, named by its exact id. Anything else is refused when the
 * manifest is read, at install and at update, so no surface ever shows a
 * name the asking app made up (DOR-3293, Security).
 */
const AppIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(
    EXTENSION_ID_REGEX,
    'Name each app by its id: lowercase letters, numbers and hyphens, like "mkt-core".'
  );

const RoutePatternSchema = z
  .string()
  .max(400)
  .regex(ROUTE_PATTERN_REGEX, 'Use a path like /items or /items/:id');

/** The methods one route entry names, each once. */
const MethodsSchema = z
  .array(z.enum(APP_ROUTE_METHODS))
  .min(1)
  .refine((methods) => new Set(methods).size === methods.length, 'List each method once');

/** One route a target lets other apps call. */
export const AppExportRouteSchema = z
  .object({
    /** The route, e.g. `/briefs` or `/briefs/:id`. */
    path: RoutePatternSchema,
    /** What other apps may do there. A write needs its own entry. */
    methods: MethodsSchema,
    /** Only these apps may call it. Leave it out to let any app that lists this one call it. */
    callers: z.array(AppIdSchema).min(1).optional(),
  })
  .strict();

/**
 * A route only the target's own screens may call: a path, for every method
 * there, or a path and the methods it covers.
 */
export const PersonOnlyRuleSchema = z.union([
  RoutePatternSchema,
  z
    .object({
      /** The route, e.g. `/approvals` or `/variants/:id`. */
      path: RoutePatternSchema,
      /** The methods only this app's screens may use there. */
      methods: MethodsSchema,
    })
    .strict(),
]);

/** What a target lets other apps reach. */
export const ExtensionExportsSchema = z
  .object({
    /** Routes other apps may call. Nothing is exported unless it is listed here. */
    http: z.array(AppExportRouteSchema).max(100).optional(),
    /**
     * Routes only this app's own screens may call, e.g. `/approve`, or
     * `{ "path": "/approvals", "methods": ["POST"] }` for some methods only.
     * Never exported, whatever `http` says.
     */
    personOnly: z.array(PersonOnlyRuleSchema).max(100).optional(),
  })
  .strict();

/**
 * One app this one uses: its exact id, to call its exported routes, or
 * `{ id, navigate: true }` to also open its pages.
 */
export const CalledAppEntrySchema = z.union([
  AppIdSchema,
  z
    .object({
      /** The app's exact id. */
      id: AppIdSchema,
      /** Whether this app may also send the person to that app's pages. */
      navigate: z.boolean().optional(),
    })
    .strict(),
]);

/** `capabilities.http`: `true` for this app's own routes, or the apps it also uses. */
export const HttpCapabilitySchema = z.union([
  z.boolean(),
  z
    .object({
      /** The apps this one uses, each once. */
      apps: z.array(CalledAppEntrySchema).max(MAX_CALLED_APPS),
    })
    .strict(),
]);

/** One app this one uses. */
export type CalledAppEntry = z.infer<typeof CalledAppEntrySchema>;

/** One route a target lets other apps call. */
export type AppExportRoute = z.infer<typeof AppExportRouteSchema>;
/** What a target lets other apps reach. */
export type ExtensionExports = z.infer<typeof ExtensionExportsSchema>;
/** A route only the target's own screens may call. */
export type PersonOnlyRule = z.infer<typeof PersonOnlyRuleSchema>;

/** A `personOnly` rule read as a path and the methods it covers. */
interface PersonOnlyMethods {
  path: string;
  methods: readonly AppRouteMethod[];
}

/** Every `personOnly` rule as a path and methods; a bare path covers every method. */
function personOnlyRules(exports: ExtensionExports | undefined): PersonOnlyMethods[] {
  return (exports?.personOnly ?? []).map((rule) =>
    typeof rule === 'string' ? { path: rule, methods: APP_ROUTE_METHODS } : rule
  );
}

/** The parts of a manifest a cross-app decision reads. */
export interface CrossAppManifest {
  id: string;
  capabilities?: { http?: boolean | { apps: CalledAppEntry[] } };
  exports?: ExtensionExports;
}

/** The entries of `capabilities.http.apps`, each as `{ id, navigate }`. */
function appEntries(
  manifest: Pick<CrossAppManifest, 'capabilities'>
): { id: string; navigate: boolean }[] {
  const http = manifest.capabilities?.http;
  if (typeof http !== 'object') return [];
  return http.apps.map((entry) =>
    typeof entry === 'string'
      ? { id: entry, navigate: false }
      : { id: entry.id, navigate: entry.navigate === true }
  );
}

/**
 * The apps a manifest says it uses, in the order it lists them.
 *
 * @param manifest - The caller's manifest.
 */
export function calledApps(manifest: Pick<CrossAppManifest, 'capabilities'>): string[] {
  return [...new Set(appEntries(manifest).map((entry) => entry.id))];
}

/**
 * The apps whose pages a manifest says it opens (`navigate: true`), in order.
 *
 * @param manifest - The caller's manifest.
 */
export function openableApps(manifest: Pick<CrossAppManifest, 'capabilities'>): string[] {
  return [
    ...new Set(
      appEntries(manifest)
        .filter((entry) => entry.navigate)
        .map((entry) => entry.id)
    ),
  ];
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
  if (
    personOnlyRules(exports).some(
      (rule) => rule.methods.includes(method) && routeMatches(rule.path, path)
    )
  ) {
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
  const personOnly = personOnlyRules(target.exports);
  // Only the methods no overlapping person-only rule takes back.
  const methods = (target.exports?.http ?? [])
    .filter((route) => !route.callers || route.callers.includes(callerId))
    .flatMap((route) =>
      route.methods.filter(
        (method) =>
          !personOnly.some(
            (rule) => rule.methods.includes(method) && routesOverlap(rule.path, route.path)
          )
      )
    );
  const reads = methods.includes('GET');
  const changes = methods.some((method) => method !== 'GET');
  if (reads && changes) return 'both';
  if (reads) return 'reads';
  return changes ? 'changes' : null;
}

/** The most segments an item path may have. */
export const MAX_ITEM_PATH_SEGMENTS = 8;

/** The longest an item path may be. */
export const MAX_ITEM_PATH_LENGTH = 400;

/**
 * An item path: `''` for the app's home, or `/` then segments of plain
 * letters, digits and `-._~`, never `.` or `..`, and nothing else: no query,
 * no hash, no `%`, no empty segment.
 */
const ITEM_PATH_REGEX = /^(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~-]+)*$/;

/** Why opening another app's page was refused. */
export type AppNavigateRefusal =
  'not-declared' | 'self' | 'target-unavailable' | 'not-an-item-path';

/** The answer to opening another app's page: allowed, or refused and why. */
export type AppNavigateDecision = { ok: true } | { ok: false; reason: AppNavigateRefusal };

/**
 * Decide one app sending the person to another app's page, at
 * `/x/<targetId><itemPath>`.
 *
 * The caller must list the target in `capabilities.http.apps` with
 * `navigate: true`; the target needs no export, because a page only shows what the person can already
 * open. The link carries the item's path and nothing else (see
 * {@link ITEM_PATH_REGEX}). Both manifests come from DorkOS's own records; a
 * target that is not installed, or not running, is passed as `null`.
 *
 * @param input - The caller, the target, and the page's path below the target.
 * @returns Allowed, or the reason it was refused.
 */
export function decideAppNavigate(input: {
  caller: CrossAppManifest;
  target: CrossAppManifest | null;
  targetId: string;
  itemPath: string;
}): AppNavigateDecision {
  const { caller, target, targetId, itemPath } = input;
  if (targetId === caller.id) return { ok: false, reason: 'self' };
  if (!openableApps(caller).includes(targetId)) return { ok: false, reason: 'not-declared' };
  if (!target || target.id !== targetId) return { ok: false, reason: 'target-unavailable' };
  if (
    itemPath.length > MAX_ITEM_PATH_LENGTH ||
    !ITEM_PATH_REGEX.test(itemPath) ||
    itemPath.split('/').length - 1 > MAX_ITEM_PATH_SEGMENTS
  ) {
    return { ok: false, reason: 'not-an-item-path' };
  }
  return { ok: true };
}

/**
 * The manifest checks that span fields: an export never overlaps a
 * `personOnly` rule on a method both name, and an app never lists itself as
 * an app it calls.
 *
 * @param manifest - The manifest's parsed fields.
 * @param ctx - Where each issue is added.
 */
export function checkCrossAppDeclarations(manifest: CrossAppManifest, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  appEntries(manifest).forEach(({ id }, index) => {
    if (id === manifest.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', 'http', 'apps', index],
        message: 'An app does not list itself; its own routes need only `http: true`',
      });
    } else if (seen.has(id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', 'http', 'apps', index],
        message: `"${id}" is listed twice; list each app once`,
      });
    }
    seen.add(id);
  });
  const personOnly = personOnlyRules(manifest.exports);
  (manifest.exports?.http ?? []).forEach((route, index) => {
    for (const rule of personOnly) {
      const shared = route.methods.filter((method) => rule.methods.includes(method));
      if (shared.length === 0 || !routesOverlap(rule.path, route.path)) continue;
      ctx.addIssue({
        code: 'custom',
        path: ['exports', 'http', index, 'path'],
        message: `${shared.join(', ')} "${route.path}" overlaps the personOnly route "${rule.path}", which is never exported`,
      });
      return;
    }
  });
}
