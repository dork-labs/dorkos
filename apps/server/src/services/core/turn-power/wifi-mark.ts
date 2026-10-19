/**
 * The Wi-Fi mark (DOR-3061, `specs/turn-marks/design-note.md`): words from a Wi-Fi sign-in, held
 * the same way wherever the turn they reach goes.
 *
 * A Wi-Fi sign-in reaches DorkOS over plain `http` on the local network, where anyone on the same
 * network can watch or relay the traffic. Its words are an outsider's in every way the outsider
 * mark already handles (notes stamped and held, the permission gate asks, schedules park,
 * promises refused), so the Wi-Fi mark always rides with the outsider mark. On top of that:
 *
 * - **Default at most.** A Wi-Fi-marked turn runs no looser than the receiving runtime's default,
 *   whatever the agent's own level ({@link wifiTurnOpts}, applied by `applyTurnMarks`), so every
 *   file or shell step asks.
 * - **Allow once only.** No card the turn raises offers Always allow, and a standing yes sent
 *   anyway is answered once at most ({@link withoutStandingYes}, {@link withoutAlwaysAllow}):
 *   one card must never become a lasting grant.
 *
 * The mark starts where a request is known to come from Wi-Fi: such a route spreads
 * {@link wifiTurnCeiling} into the turn it starts, and a person's post from Wi-Fi is kept with
 * {@link WIFI_LEVEL}. From there it rides every carrier the turn-mark set already rides.
 *
 * @module services/core/turn-power/wifi-mark
 */
import type {
  MessageOpts,
  ToolDecisionOptions,
  TurnPermissionBound,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';

/**
 * The level a Wi-Fi sign-in's words are kept with: the two marks and no power bound of its own.
 * It is the loosest level there is on purpose, so beside `'runtime-default'` the turn gets exactly
 * the runtime's default and no stricter (a runtime whose default reads only must still find a
 * mode). It never travels alone: {@link WIFI_CEILING} pairs it with the default, and
 * `applyTurnMarks` adds the default to any Wi-Fi-marked turn whatever else it carries.
 */
export const WIFI_LEVEL: TurnPermissionLevel = Object.freeze({
  asks: 'never',
  reach: 'everything',
  auto: true,
  outsider: true,
  wifi: true,
});

/** The ceiling a turn started from Wi-Fi is sent with: the runtime's default, carrying the mark. */
export const WIFI_CEILING: TurnPermissionCeiling = Object.freeze([
  'runtime-default',
  WIFI_LEVEL,
]) as TurnPermissionCeiling;

/**
 * The ceiling a turn a request starts carries, as the spread a dispatch takes: {@link WIFI_CEILING}
 * when the request came from Wi-Fi, nothing otherwise. The one call a route makes once it knows
 * where the request came from (the Wi-Fi listener's ingress, never the cookie).
 *
 * @param fromWifi - Whether the Wi-Fi listener admitted the request.
 */
export function wifiTurnCeiling(fromWifi: boolean): { permissionCeiling?: TurnPermissionCeiling } {
  return fromWifi ? { permissionCeiling: WIFI_CEILING } : {};
}

/** Whether a ceiling already holds the runtime's default as one of its bounds. */
function holdsDefault(ceiling: TurnPermissionCeiling | undefined): boolean {
  if (ceiling === undefined) return false;
  if (!Array.isArray(ceiling)) return ceiling === 'runtime-default';
  return (ceiling as readonly TurnPermissionBound[]).includes('runtime-default');
}

/**
 * The options a Wi-Fi-marked turn is sent with: its ceiling holds the runtime's default as well as
 * every bound (and mark) it had, so a hop that carried the mark on a level alone is still capped.
 *
 * @param opts - The options the caller sent; the turn's marks were read from them.
 */
export function wifiTurnOpts(opts: MessageOpts | undefined): MessageOpts {
  const ceiling = opts?.permissionCeiling;
  if (holdsDefault(ceiling)) return opts!;
  const bounds: readonly TurnPermissionBound[] =
    ceiling === undefined
      ? []
      : Array.isArray(ceiling)
        ? (ceiling as readonly TurnPermissionBound[])
        : [ceiling as TurnPermissionBound];
  return { ...opts, permissionCeiling: ['runtime-default', ...bounds] };
}

/**
 * An event with any offer of a standing yes taken off: a tool card that would offer Always allow
 * offers Allow once and Deny only. Every other event comes back as it was.
 *
 * @param event - One event of a Wi-Fi-marked turn.
 */
export function withoutStandingYes(event: StreamEvent): StreamEvent {
  if (event.type !== 'approval_required') return event;
  const data = event.data as Record<string, unknown> | undefined;
  if (!data || (data.hasSuggestions !== true && data.alwaysAllowScope === undefined)) return event;
  const { alwaysAllowScope: _offered, ...rest } = data;
  return { ...event, data: { ...rest, hasSuggestions: false } } as StreamEvent;
}

/**
 * A tool decision with any standing yes taken off, so an answer to a Wi-Fi-marked turn's card is
 * Allow once at most, whoever sends it and however.
 *
 * @param options - The decision as sent.
 */
export function withoutAlwaysAllow(
  options: ToolDecisionOptions | undefined
): ToolDecisionOptions | undefined {
  if (options?.alwaysAllow !== true) return options;
  const { alwaysAllow: _standing, ...rest } = options;
  return rest;
}

/** The cards Wi-Fi-marked turns raised, by tool call id, newest last. */
const onceOnlyCards = new Set<string>();

/** How many such cards are remembered; a card is answered or gone long before this many. */
const ONCE_ONLY_MEMORY = 10_000;

/**
 * Whether a Wi-Fi-marked turn raised this card, so it is answered once at most. Kept on the card
 * itself, so the answer is right whichever id of the chat it arrives under.
 *
 * @param toolCallId - The card's tool call id.
 */
export function isOnceOnlyCard(toolCallId: string): boolean {
  return onceOnlyCards.has(toolCallId);
}

/** Remember that a Wi-Fi-marked turn raised this card. */
function noteOnceOnlyCard(event: StreamEvent): void {
  if (event.type !== 'approval_required') return;
  const data = event.data as { toolCallId?: unknown; id?: unknown } | undefined;
  const id = typeof data?.toolCallId === 'string' ? data.toolCallId : data?.id;
  if (typeof id !== 'string') return;
  onceOnlyCards.delete(id);
  onceOnlyCards.add(id);
  if (onceOnlyCards.size > ONCE_ONLY_MEMORY) {
    onceOnlyCards.delete(onceOnlyCards.values().next().value as string);
  }
}

/**
 * A Wi-Fi-marked turn's events, each with any offer of a standing yes taken off
 * ({@link withoutStandingYes}), and each card it raises remembered as Allow once only
 * ({@link isOnceOnlyCard}). Stopping the stream stops the turn's own.
 *
 * @param events - The turn's events.
 */
export async function* offeringOnlyOnce(
  events: AsyncIterable<StreamEvent>
): AsyncGenerator<StreamEvent> {
  for await (const event of events) {
    noteOnceOnlyCard(event);
    yield withoutStandingYes(event);
  }
}
