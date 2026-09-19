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
 * ## Two sources, in the order the binding write honours them
 *
 * 1. **What the person already chose for THIS conversation.** A settings change
 *    made before sending writes a `session_metadata` row with no runtime
 *    (DOR-812's pre-launch picker), and the binding write then fills only
 *    columns still holding NULL — so that choice survives the seed and must
 *    win here too. It is read through `getStoredSessionSettings`, the one
 *    server read that can see an unstarted session's row; every other session
 *    read resolves a session out of its runtime's store (ADR-0310) and cannot.
 *    That read is what closes the reload case: before it existed, moving the
 *    dial DOWN before sending and reloading left the screen showing the
 *    operator's configured stop over a level the person had deliberately
 *    lowered — claiming more power than the turn would run at.
 * 2. **The operator's configured stop**, resolved against the runtime this
 *    session would bind to. `startModeFor` is shared with the server's seed
 *    (see its own note): one mapping, so the dial and the seed cannot land on
 *    different modes for one dial position.
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
import { useQuery } from '@tanstack/react-query';
import type { PermissionModeId } from '@dorkos/shared/types';
import { useConfig } from '@/layers/entities/config';
import { useCapabilitiesForRuntime, useRuntimeCapabilities } from '@/layers/entities/runtime';
import { operatorStopForRuntime, startModeFor } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
// Same-slice imports via sibling modules (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../../api/query-keys';
import { useSessions } from '../query/use-sessions';

/**
 * How long a stored-settings answer stays fresh.
 *
 * Short, because the row it reads changes under the person's own hand: every
 * pre-first-message settings change writes it. The value that actually keeps
 * the screen current is not this number but the detail-cache write
 * `useSessionStatus.updateSession` already performs, which wins over this read
 * in the precedence below; this bounds how long a value from ANOTHER window
 * takes to arrive.
 */
const STORED_SETTINGS_STALE_MS = 5_000;

/**
 * Resolve what an unstarted session will run its first turn at, or `undefined`
 * when there is nothing honest to say.
 *
 * `undefined` covers two genuinely different states, and the caller does not
 * have to tell them apart because the answer is the same either way — draw
 * nothing committal:
 *
 * - **Still loading.** The session list, the config, the capability map or the
 *   stored-settings read is in flight.
 * - **Declined.** The session has started, so its own row is the truth.
 *
 * What a caller must NOT do is paint a default-shaped value here. The
 * permissions control gates on `permissionModeKnown`
 * (`useSessionStatus`), which is exactly "a row or this hook has answered";
 * painting the placeholder instead reproduces the DOR-2103 symptom in
 * compressed form — the dial reads "Default" for a few frames, then flips.
 *
 * @param sessionId - The session on screen, or null when none is selected. A
 *   client-minted id for an unsent conversation is the case this hook is for.
 * @param runtime - The runtime this session would bind to, as the CLIENT can
 *   best guess it: the launch picker's selection, else nullish to read the
 *   server's default runtime.
 *
 *   **It is a guess, and it is not the server's whole ladder.**
 *   `resolveRuntimeTypeForNewSession` (`routes/sessions.ts`) answers the
 *   explicit hint, then the AGENT MANIFEST's runtime where that runtime is
 *   registered, then the registry default — and the manifest tier has no client
 *   mirror here. So for a session started in a directory whose agent names a
 *   runtime other than the picker's selection, this can name a different
 *   runtime than the session binds to. Latent today: all three shipped runtimes
 *   file the same mode id at each stop, so the resolved id is identical whoever
 *   answers. `configured-stop-on-screen.test.ts` carries the case that would
 *   catch it becoming real (test-mode's ids overlap with nobody's).
 */
export function useSessionStartMode(
  sessionId: string | null,
  runtime?: string | null
): PermissionModeId | undefined {
  const transport = useTransport();
  const { sessions, isAnswered } = useSessions();
  const { data: config, isPending: configPending } = useConfig();
  const { data: capabilityMap, isPending: capabilitiesPending } = useRuntimeCapabilities();
  // Resolved to a concrete runtime type ONCE, so the capability profile below
  // and the per-runtime config override are read for the same runtime. Reading
  // the default separately at each of them would compare a runtime named by
  // `capabilities.defaultRuntime` against an override keyed by
  // `executionDefaults.runtime` — two answers to one question.
  const forRuntime = runtime ?? capabilityMap?.defaultRuntime ?? null;
  const caps = useCapabilitiesForRuntime(forRuntime);

  // Unstarted, and known to be: `isAnswered` is what tells "this project has no
  // such session" from "nobody has asked yet" (`useSessions` documents it).
  const unstarted =
    sessionId !== null && isAnswered && !sessions.some((session) => session.id === sessionId);

  // Asked only about an unstarted session, so a rail of listed conversations
  // never issues one of these: a started session's settings already ride its
  // `Session`, overlaid server-side from the same row.
  const { data: stored, isPending: storedPending } = useQuery({
    queryKey: sessionKeys.storedSettings(sessionId),
    queryFn: () => transport.getStoredSessionSettings(sessionId!),
    staleTime: STORED_SETTINGS_STALE_MS,
    enabled: unstarted,
  });

  // Not a session, not yet known to be unstarted, or started (its own row is
  // the truth). The gate is the list, and `unstarted` folds all three.
  if (!unstarted) return undefined;
  // A disabled query reports `isPending: true` forever, so the gate above is
  // what keeps this from reading as permanently in-flight on a started session.
  if (storedPending || configPending || capabilitiesPending) return undefined;

  // The person's own choice for THIS conversation, made before sending. It
  // outranks the configured stop exactly as it outranks the seed.
  if (stored?.permissionMode !== undefined) return stored.permissionMode;

  // A runtime that declares no permission modes has no dial and nothing to say.
  if (!caps?.permissionModes.supported) return undefined;

  const stop = operatorStopForRuntime(config?.executionDefaults, forRuntime ?? '');
  return startModeFor(stop, caps.permissionModes);
}
