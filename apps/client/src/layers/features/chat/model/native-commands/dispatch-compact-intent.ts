/**
 * Shared dispatch for the runtime-fulfilled `compact` command intent (DOR-109).
 * Both surfaces that can fire `/compact` — the slash-command send funnel
 * ({@link import('./use-native-commands').useNativeCommands}) and the
 * proactive compaction chip
 * ({@link import('../status/use-compaction-chip').useCompactionChip}, DOR-112)
 * — call through here so a failed dispatch always shows the exact same toast,
 * never two copies that can drift apart. Lives alongside the native-commands
 * submodule (rather than loose in `chat/model/`) since that's the intent's
 * original home from DOR-109; the compaction chip reaches in via this
 * submodule's public `index.ts`.
 *
 * @module features/chat/model/native-commands/dispatch-compact-intent
 */
import { toast } from 'sonner';
import type { Transport } from '@dorkos/shared/transport';

/**
 * Fire the `compact` intent and toast on failure.
 *
 * Trigger-only (202): the compaction itself is delivered out-of-band over the
 * durable `/events` stream (a `compact_boundary`), never through this
 * promise's resolution. Callers that need to reflect an in-flight state
 * should track the session's existing streaming signal, not invent new stream
 * handling around this call.
 *
 * @param transport - The active Transport.
 * @param sessionId - Target session id.
 * @param instructions - Optional trailing instructions to forward (e.g. the
 *   remainder of `/compact <instructions>`); omitted for a plain chip click.
 * @returns `true` when the 202 trigger was accepted; `false` when it failed —
 *   a toast has already been shown in that case, so callers only need the
 *   result to decide whether to re-enable their own affordance.
 */
export async function dispatchCompactIntent(
  transport: Transport,
  sessionId: string,
  instructions?: string
): Promise<boolean> {
  try {
    await transport.runCommandIntent(sessionId, 'compact', instructions);
    return true;
  } catch (err) {
    const locked = (err as { code?: string }).code === 'SESSION_LOCKED';
    toast.error(
      locked
        ? 'The agent is busy — try compacting again in a moment.'
        : "Couldn't compact the conversation."
    );
    return false;
  }
}
