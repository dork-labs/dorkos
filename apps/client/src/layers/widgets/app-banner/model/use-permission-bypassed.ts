import { useSessionDetail, useSessionPermissionMode } from '@/layers/entities/session';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { isBypassPermissionMode, isBypassSemantics } from '@/layers/shared/lib';
import { useSafePathname } from '@/layers/shared/model';

/**
 * Whether the given session is running with every permission bypassed — the
 * agent executes any tool without asking. Reads the session entity's one
 * permission-mode source rather than deriving it again, so the banner can never
 * stay quiet about a session the status line is already flagging. Returns false
 * when there is no session or it is not in a bypass mode.
 *
 * The answer comes from what the session's runtime says the mode DOES
 * (`isBypassSemantics`), so a runtime whose "run everything" mode has a name
 * nobody in the client has heard of still raises the banner. Until the
 * capability map arrives — or for a session with no runtime row yet — it falls
 * back to the mode's name, which is the same answer for every runtime shipped
 * today and a better guess than silence.
 *
 * The banner is a passive reporter: it fetches the session row only on the route
 * that displays that session (the Obsidian embed is always one). Everywhere else
 * it still tracks the cache and warns off whatever is in it, but it does not go
 * request a row for a page — `/agents`, `/marketplace` — that shows nothing
 * about the session. Resolving the runtime keeps that promise: it reads the same
 * gated session row, one field over, rather than reaching for the session LIST —
 * which would drag the router in and start a query on pages that show none.
 *
 * @param sessionId - The active session id, or null when none is selected.
 */
export function usePermissionBypassed(sessionId: string | null): boolean {
  const isSessionRoute = useSafePathname() === '/session';
  const mode = useSessionPermissionMode(sessionId, { enabled: isSessionRoute });
  const { data: runtime } = useSessionDetail(sessionId, {
    enabled: isSessionRoute,
    select: (session) => session.runtime,
  });
  const caps = useCapabilitiesForRuntime(runtime);
  const descriptor = caps?.permissionModes.values.find((d) => d.id === mode);
  return descriptor ? isBypassSemantics(descriptor) : isBypassPermissionMode(mode);
}
