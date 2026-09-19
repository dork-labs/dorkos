/**
 * What power a conversation nobody has sent a message to yet WILL run at.
 *
 * ## The defect this exists for (DOR-2103)
 *
 * A session's permission mode is written at the binding write on the first
 * message — `persistSessionRuntime` → `permissionSeedForOrigin` →
 * `resolveSessionDefaults` (DOR-2105). Before that write there is no
 * `session_metadata` row at all, and `GET /api/sessions/:id` answers 404 for a
 * session with no transcript, so the client had nothing to read and filled the
 * hole with the literal `'default'`. An operator whose configured stop was Full
 * autonomy opened a new conversation, read "Default — asks before it edits a
 * file or runs a command" on the dial and on the row, sent one message, and
 * watched it silently become Full autonomy. The turn was always going to run at
 * their own stop; only the screen was wrong, and it was wrong at exactly the
 * moment a person looks to check.
 *
 * So this hook answers the same question the seed answers, on the same two
 * inputs, before the seed exists: **the mode this session would start its first
 * turn at.** `resolveStopMode` is shared with the server's resolver on purpose
 * (see its own note) — one mapping, so the dial and the seed cannot land on
 * different modes for one dial position.
 *
 * ## It never answers for a session that has started
 *
 * A session in the list has a row on the wire, and that row is the truth —
 * whatever a person later chose, and whatever mode the runtime reports for a
 * transcript nobody configured. Answering `undefined` there is not a fallback,
 * it is the point: a guess must never displace a stored value, in either
 * direction. That gate is the session LIST rather than the session id, for the
 * reason `useResolvedSessionRuntime` states — a client-minted `?session=<uuid>`
 * is truthy in every pre-first-message state, so id presence cannot stand in
 * for started-ness.
 *
 * ## Nothing here is written down
 *
 * This is a display answer and it stays one. The server refuses to persist the
 * same inference for the same reason (DOR-812: a guess written down becomes the
 * binding, and `persistSessionRuntime` is first-write-wins), and a client that
 * PATCHed this value on mount would create exactly the row that refusal exists
 * to prevent.
 *
 * @module entities/session/model/settings/use-session-start-mode
 */
import type { PermissionModeId } from '@dorkos/shared/types';
import { useConfig } from '@/layers/entities/config';
import { useCapabilitiesForRuntime, useRuntimeCapabilities } from '@/layers/entities/runtime';
import { operatorStopForRuntime, resolveStopMode } from '@/layers/shared/lib';
// Same-slice import via the sibling module (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { useSessions } from '../query/use-sessions';

/**
 * The mode a session with nothing stored for it would run its first turn at, or
 * `undefined` when there is nothing honest to say.
 *
 * `undefined` covers four states, and they are all the same state — "do not
 * put a guess on the screen":
 *
 * 1. No session id.
 * 2. The session is already in the list, so it has a real mode of its own.
 * 3. The list has not answered yet, so 2 cannot be ruled out.
 * 4. The config or the capability map is still loading, or the runtime declares
 *    no permission modes at all.
 *
 * The resolution itself is the server's own ladder for this one key, read off
 * the two facts the client already holds: `config.executionDefaults` (the
 * per-runtime `trustStop` override, then the global one —
 * `describeExecutionDefaults` reports both UNRESOLVED precisely so the screen
 * resolves them against the runtime's profile rather than trusting a second
 * copy on the wire), and that runtime's declared modes. A configured stop the
 * runtime declares no mode for contributes nothing and the runtime's OWN
 * declared default answers, which is what actually happens: the seed writes
 * nothing, the column stays NULL, and NULL means "the runtime decides"
 * everywhere else.
 *
 * @param sessionId - The session on screen, or null when none is selected. A
 *   client-minted id for an unsent conversation is the case this hook is for.
 * @param runtime - The runtime this session would bind to: the launch picker's
 *   selection when the client holds one, else nullish to read the server's
 *   default runtime. An unbound session's runtime is INFERRED (the registry's
 *   `resolveSessionRuntime` answers `bound: false`), so there is no
 *   server-authoritative answer to prefer over the picker's.
 */
export function useSessionStartMode(
  sessionId: string | null,
  runtime?: string | null
): PermissionModeId | undefined {
  const { sessions, isAnswered } = useSessions();
  const { data: config } = useConfig();
  const { data: capabilityMap } = useRuntimeCapabilities();
  // Resolved to a concrete runtime type ONCE, so the capability profile below
  // and the per-runtime config override are read for the same runtime. Reading
  // the default separately at each of them would compare a runtime named by
  // `capabilities.defaultRuntime` against an override keyed by
  // `executionDefaults.runtime` — two answers to one question.
  const forRuntime = runtime ?? capabilityMap?.defaultRuntime ?? null;
  const caps = useCapabilitiesForRuntime(forRuntime);

  if (!sessionId) return undefined;
  // Started, or not yet known to be unstarted. Either way the row answers.
  if (!isAnswered || sessions.some((session) => session.id === sessionId)) return undefined;
  if (!forRuntime || !caps?.permissionModes.supported) return undefined;

  const stop = operatorStopForRuntime(config?.executionDefaults, forRuntime);
  return resolveStopMode(stop, caps.permissionModes.values) ?? caps.permissionModes.default;
}
