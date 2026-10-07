/**
 * The spaces experiment (DOR-2740) and its one exception, the official space (spec
 * `official-community-space` D5), as the server's route gates.
 *
 * Every route that reaches a space (a Community on another server) sits behind one of the gates
 * below, mounted where DOR-2740 mounted its whole-feature gate: `/api/communities`,
 * `/api/community-connections` and `/api/cloud/communities`. While the experiment is off each
 * refuses with 404 {@link SPACES_DISABLED_CODE}, so a client can tell "this feature is off" from
 * "that space does not exist", except for what the official space needs. This machine's own
 * rooms never pass through here. Nothing is deleted while spaces are off: turning them back on
 * finds every connection where it was left.
 *
 * @module middleware/spaces-enabled
 */
import type { Request, Response, NextFunction } from 'express';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { spacesEnabled } from '../services/communities/spaces-config.js';
import { getOfficialSpace } from '../services/communities/remote/state.js';

export { spacesEnabled };

/** The `code` a space route answers with while the spaces experiment is off. */
export const SPACES_DISABLED_CODE = 'SPACES_DISABLED';

/**
 * `spaceReachable(ref)` (spec `official-community-space` D5): whether one space may be reached
 * right now. True while the spaces experiment is on, and for the official space whatever the
 * experiment says. Every space surface that names a connection asks this, not the experiment
 * alone.
 *
 * @param ref - The local connection ref.
 */
export function spaceReachable(ref: CommunityRef): boolean {
  return getOfficialSpace().reachable(ref);
}

/** Answer the refusal every space route gives while spaces are off. */
export function refuseSpacesDisabled(res: Response): void {
  res.status(404).json({
    error: 'Spaces are switched off. Turn them on in Settings → Advanced → Experiments.',
    code: SPACES_DISABLED_CODE,
  });
}

/**
 * What a space gate asks about the official space (spec `official-community-space` D5). The
 * production answer is {@link getOfficialSpace}; a test passes its own.
 */
export interface SpaceAccess {
  /** `spaceReachable(ref)`: the experiment is on, or this is the official space. */
  reachable(ref: CommunityRef): boolean;
  /** Whether a typed link is the configured official link. */
  isOfficialLink(url: string): boolean;
  /** The official link's origin, or `null` when there is no official space. */
  origin(): string | null;
}

/**
 * Set on `res.locals` by a gate that let a request through only for the official space. A route
 * that answers with a list narrows it to the official space when it sees this, so the gate and
 * the route agree on one rule without the route reading config itself.
 */
export const SPACES_OFFICIAL_ONLY = 'spacesOfficialOnly';

/** Where {@link SPACES_OFFICIAL_ONLY} keeps the official space's origin for the route. */
const SPACES_OFFICIAL_ORIGIN = 'spacesOfficialOrigin';

/** Whether a gate let this request through for the official space alone. */
export function officialOnly(res: Response): boolean {
  return res.locals[SPACES_OFFICIAL_ONLY] === true;
}

/**
 * The official space's origin when a gate let this request through for it alone, or `null`
 * otherwise (including when there is no official space).
 */
export function officialOnlyOrigin(res: Response): string | null {
  const origin: unknown = res.locals[SPACES_OFFICIAL_ORIGIN];
  return officialOnly(res) && typeof origin === 'string' ? origin : null;
}

type Gate = (req: Request, res: Response, next: NextFunction) => void;

/**
 * Build one space router's gate (spec `official-community-space` D5). DOR-2740 gated each of
 * these routers whole at its mount; this keeps that mount and the same refusal, and lets
 * through, while the experiment is off, only what the official space needs. `decide` names the
 * connection a request is about (its `:ref`), `'official-only'` for a request the router itself
 * narrows to the official space, or `null` for one that stays off. A `:ref` passes only when
 * `spaceReachable(ref)` says so, so a route added later under a ref is covered by construction,
 * and one added without a ref is off until `decide` says otherwise.
 */
function spaceGate(
  decide: (req: Request, segments: readonly string[], access: SpaceAccess) => string | null,
  access: () => SpaceAccess
): Gate {
  return (req, res, next) => {
    if (spacesEnabled()) {
      next();
      return;
    }
    const current = access();
    // No official space configured: the exception is dormant and every request refuses, exactly
    // as DOR-2740 shipped it.
    if (current.origin() === null) {
      refuseSpacesDisabled(res);
      return;
    }
    const segments = req.path.split('/').filter(Boolean);
    const decision = decide(req, segments, current);
    if (decision === 'official-only') {
      res.locals[SPACES_OFFICIAL_ONLY] = true;
      res.locals[SPACES_OFFICIAL_ORIGIN] = current.origin();
      next();
      return;
    }
    if (decision !== null && current.reachable(decision as CommunityRef)) {
      next();
      return;
    }
    refuseSpacesDisabled(res);
  };
}

/** The `ref` a JSON body names, or `null`. */
function bodyRef(req: Request): string | null {
  const ref = (req.body as { ref?: unknown } | undefined)?.ref;
  return typeof ref === 'string' && ref ? ref : null;
}

/**
 * Gate for `/api/community-connections` while spaces are off: the list (narrowed to the official
 * row), starting a pairing from the official link only, the navigation reads and writes about
 * the official space, and every `/:ref` route for the official connection.
 *
 * @param access - The official-space answer, read per request.
 */
export function gateCommunityConnections(access: () => SpaceAccess = getOfficialSpace): Gate {
  return spaceGate((req, segments, current) => {
    if (segments.length === 0) {
      if (req.method === 'GET') return 'official-only';
      if (req.method === 'POST') {
        const url = (req.body as { url?: unknown } | undefined)?.url;
        return typeof url === 'string' && current.isOfficialLink(url) ? 'official-only' : null;
      }
      return null;
    }
    if (segments[0] === 'navigation') {
      const [, second, third] = segments;
      if (segments.length === 1) return req.method === 'GET' ? 'official-only' : null;
      if (segments.length === 2 && second === 'installation')
        return req.method === 'PUT' ? 'official-only' : null;
      if (segments.length === 2 && (second === 'move' || second === 'destination'))
        return bodyRef(req);
      if (segments.length === 3 && third === 'destination') return second ?? null;
      return null;
    }
    return segments[0] ?? null;
  }, access);
}

/**
 * Gate for `/api/communities`: every route there names a connection as its first segment, so
 * with spaces off only the official one answers.
 *
 * @param access - The official-space answer, read per request.
 */
export function gateRemoteCommunities(access: () => SpaceAccess = getOfficialSpace): Gate {
  return spaceGate((_req, segments) => segments[0] ?? null, access);
}

/**
 * Gate for `/api/cloud/communities`: with spaces off only `GET /sign-in` answers, and only about
 * the official space's server. Starting, hosting and moving spaces stay off.
 *
 * @param access - The official-space answer, read per request.
 */
export function gateCloudCommunities(access: () => SpaceAccess = getOfficialSpace): Gate {
  return spaceGate(
    (req, segments) =>
      req.method === 'GET' && segments.length === 1 && segments[0] === 'sign-in'
        ? 'official-only'
        : null,
    access
  );
}
