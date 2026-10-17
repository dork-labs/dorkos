/**
 * Words and small calculations for a document's route controls, kept apart from
 * the components so they read the same in every row and are tested once.
 *
 * @module features/canvas/lib/doc-routes
 */
import type {
  CanvasDocRoute,
  CanvasDocRouteDestination,
  CanvasDocRouteLimits,
  CanvasDocRouteState,
} from '@dorkos/shared/canvas-doc-routes';

/** How long a person can allow a route for. Short on purpose; allowing again is one click. */
export const ROUTE_EXPIRY_CHOICES = [
  { value: 'hour', label: '1 hour', ms: 3_600_000 },
  { value: 'day', label: '1 day', ms: 86_400_000 },
  { value: 'week', label: '1 week', ms: 604_800_000 },
] as const;

/** One expiry choice's key. */
export type RouteExpiryChoice = (typeof ROUTE_EXPIRY_CHOICES)[number]['value'];

/**
 * The end time a choice means, rounded up to the minute so the time shown and
 * the time granted are the same time.
 *
 * @param choice - Which duration.
 * @param now - The current time, in ms.
 */
export function routeExpiryFrom(choice: RouteExpiryChoice, now = Date.now()): string {
  const ms = ROUTE_EXPIRY_CHOICES.find((item) => item.value === choice)!.ms;
  return new Date(Math.ceil((now + ms) / 60_000) * 60_000).toISOString();
}

const TIME = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** A route time as a person reads it, in this computer's own clock style. */
export function formatRouteTime(iso: string): string {
  return TIME.format(new Date(iso));
}

/** Where a route's events go, in words. */
export function routeDestinationLabel(destination: CanvasDocRouteDestination): string {
  switch (destination.kind) {
    case 'log':
      return 'Kept on this document';
    case 'room':
      return 'To this room';
    case 'owner':
      return destination.agentName
        ? `To ${destination.agentName}`
        : 'To the agent that opened this';
    case 'agent':
      return destination.agentName ? `To ${destination.agentName}` : 'To an agent that’s gone';
  }
}

const STATE_LABELS: Record<CanvasDocRouteState, string> = {
  no_grant: 'Off',
  granted: 'On',
  waiting: 'Waiting for you',
  suspended: 'Paused',
  revoked: 'Turned off',
  expired: 'Ended',
};

/** A route's state as a short status word. */
export function routeStateLabel(state: CanvasDocRouteState): string {
  return STATE_LABELS[state];
}

/** One line under a route saying what its state means for the person. */
export function routeStateDetail(route: CanvasDocRoute): string {
  const grant = route.grant;
  switch (route.state) {
    case 'granted':
      return grant?.expiresAt ? `Until ${formatRouteTime(grant.expiresAt)}` : 'On';
    case 'waiting':
      return 'An agent asked for this route.';
    case 'suspended':
      return 'The route or its app changed. Allow it again.';
    case 'revoked':
      return grant?.revokedAt ? `Turned off ${formatRouteTime(grant.revokedAt)}` : 'Turned off';
    case 'expired':
      return grant?.expiresAt ? `Ended ${formatRouteTime(grant.expiresAt)}` : 'Ended';
    case 'no_grant':
      return route.needsPerson
        ? 'Needs your approval to start work.'
        : 'Off until someone allows it.';
  }
}

/** A grant's caps in words. */
export function routeLimitsLabel(limits: CanvasDocRouteLimits): string {
  const turns = `${limits.turnsPerHour} ${limits.turnsPerHour === 1 ? 'turn' : 'turns'} an hour`;
  const events = `${limits.eventsPerMinute} ${limits.eventsPerMinute === 1 ? 'event' : 'events'} a minute`;
  return `${turns} · ${events}`;
}

/** How many routes are on, and how many wait on a person. */
export function routesSummary(routes: readonly CanvasDocRoute[]): { on: number; waiting: number } {
  return {
    on: routes.filter((route) => route.state === 'granted').length,
    waiting: routes.filter((route) => route.state === 'waiting').length,
  };
}

const CHANGED = 'This route changed. Review it again.';
const NOT_A_PERSON = 'Only a signed-in person can change routes.';
const REFUSALS: Record<string, string> = {
  ROUTE_CHANGED: CHANGED,
  GRANT_BINDING_CHANGED: CHANGED,
  DECLARATION_HASH_MISMATCH: CHANGED,
  MANIFEST_CHANGED: CHANGED,
  ROUTE_UNDECLARED: CHANGED,
  ROUTE_ALREADY_ON: 'This route is already on.',
  GRANT_NOT_FOUND: CHANGED,
  TARGET_UNAVAILABLE: 'The agent for this route isn’t available.',
  TARGET_IDENTITY_MISMATCH: 'The agent for this route isn’t available.',
  TARGET_SCOPE_MISMATCH: 'The agent for this route isn’t available.',
  ROOM_ROUTE_UNAVAILABLE: 'This room can’t take events right now.',
  ORIGIN_AUTHORITY_LOST: 'The agent that opened this isn’t available.',
  GRANT_EXPIRED: 'That end time has passed. Pick another.',
  AGENT_CANNOT_DECIDE: NOT_A_PERSON,
  REQUESTER_CANNOT_DECIDE: NOT_A_PERSON,
  PERSON_REQUIRED: NOT_A_PERSON,
  operator_cookie_required: NOT_A_PERSON,
  AUTH_REQUIRED: 'Sign in to change routes.',
};

/**
 * What to tell a person when a route request was refused.
 *
 * @param error - The thrown error, carrying the server's `code` when there is one.
 */
export function routeRefusal(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && REFUSALS[code]) return REFUSALS[code];
  if (error instanceof TypeError) return 'Couldn’t reach DorkOS. Check your connection.';
  return 'Couldn’t change this route. Try again.';
}
