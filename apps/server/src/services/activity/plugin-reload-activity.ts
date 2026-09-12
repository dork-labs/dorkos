/**
 * Turn a plugin reload that cost something into an Activity event (spec
 * `plugin-reload-cache-cost`).
 *
 * Installing a plugin used to rebuild the prompt cache of every open session
 * without leaving a trace anywhere: the only symptom was a slower next reply
 * and a bill that did not match the day's work. This is the trace.
 *
 * **Only reloads that cost something are recorded.** Most do not — the runtime
 * waves through any reload that does not disturb the session's tool list, and a
 * feed entry for a free refresh would bury the ones that matter under the ones
 * that do not. What lands here is the reload that threw a conversation's cache
 * away, whether it was paid at once or waited for a quiet moment first.
 *
 * @module services/activity/plugin-reload-activity
 */
import type { PaidPluginReload } from '../runtimes/claude-code/messaging/plugin-reload-policy.js';
import type { ActivityService } from './activity-service.js';

/** How long a wait lasted, in whole minutes, for the summary sentence. */
function heldForMinutes(heldMs: number): number {
  return Math.max(1, Math.round(heldMs / 60_000));
}

/** What the feed says happened, in words that need no knowledge of caches. */
function summarize(entry: PaidPluginReload): string {
  if (entry.release === 'hand-triggered') {
    return 'Switched on new plugins in a chat because you asked for them now';
  }
  if (!entry.deferred) return 'Switched on new plugins in a chat';
  if (entry.release === 'cache-cold') {
    return `Switched on new plugins in a chat once it was free, ${heldForMinutes(entry.heldMs)} min later`;
  }
  return `Switched on new plugins in a chat after waiting ${heldForMinutes(entry.heldMs)} min for a quiet moment`;
}

/**
 * Build the writer that records paid plugin reloads in the Activity feed.
 *
 * `emit` is fire-and-forget and never throws, so the returned function is safe
 * to call from a background timer with nobody to catch anything.
 *
 * @param activityService - The Activity feed writer
 * @returns A port to hand to `ClaudeCodeRuntime.setPluginReloadActivity`
 */
export function createPluginReloadActivityWriter(
  activityService: ActivityService
): (entry: PaidPluginReload) => void {
  return (entry) => {
    void activityService.emit({
      actorType: 'system',
      actorLabel: 'DorkOS',
      category: 'system',
      eventType: 'plugins.reloaded',
      resourceType: 'session',
      resourceId: entry.sessionId,
      summary: summarize(entry),
      // `?session=` is the search key the chat route reads, and the only one an
      // entry written from the server can supply — the working directory the
      // route also likes is a client-side resolution, not a fact this writer
      // holds.
      linkPath: `/session?session=${encodeURIComponent(entry.sessionId)}`,
      metadata: {
        // The estimate the session is never shown. Tokens rather than dollars
        // because tokens are what the runtime actually reports — see the policy
        // module's header — and because a price recorded today would read as a
        // fact tomorrow, when the rate has moved.
        contextTokens: entry.contextTokens ?? null,
        deferred: entry.deferred,
        heldMs: entry.heldMs,
        release: entry.release ?? null,
        mcpServersAdded: entry.impact.mcpServersAdded.length,
        mcpServersRemoved: entry.impact.mcpServersRemoved.length,
        lspToolChange: entry.impact.lspToolChange,
      },
    });
  };
}
