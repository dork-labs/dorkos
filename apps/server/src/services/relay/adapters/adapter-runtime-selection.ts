import type { RelayAdapter, AgentRuntimeLike } from '@dorkos/relay';
import type { AdapterManagerDeps } from './adapter-manager-deps.js';

/**
 * The runtime-type → runtime map an {@link AdapterManager} actually holds,
 * from whichever of the two shapes its caller passed.
 *
 * 1. An explicit `agentRuntimes` map is taken as given — the shape every
 *    composition root passes since DOR-1614, carrying every registered runtime.
 * 2. Otherwise a legacy single `agentManager` is wrapped under its OWN `type`,
 *    never a hardcoded `'claude-code'`. That hardcode was a silent killer: a
 *    TestModeRuntime landed under `'claude-code'` while every lookup asked for
 *    `'test-mode'`, so binding routing failed to initialize and the relay went
 *    quiet with one warn line (DOR-768). A bare test double declaring no `type`
 *    keeps the old key, which is what such a double means.
 * 3. Otherwise the map is empty, and the adapter factory refuses to build the
 *    built-in adapter rather than guessing which runtime it drives.
 *
 * A free function rather than a private constructor step so the rule can be
 * asserted directly, without a diagnostic accessor on the class whose only
 * reader would be its own tests.
 *
 * @param deps - The dependencies as the caller passed them.
 */
export function normalizeAgentRuntimes(
  deps: Pick<AdapterManagerDeps, 'agentRuntimes' | 'agentManager'>
): Map<string, AgentRuntimeLike> {
  if (deps.agentRuntimes) return new Map(deps.agentRuntimes);
  const runtimes = new Map<string, AgentRuntimeLike>();
  if (deps.agentManager) {
    runtimes.set(deps.agentManager.type ?? 'claude-code', deps.agentManager);
  }
  return runtimes;
}

/**
 * An adapter that can remove the bot from a chat via the platform's own leave
 * call (DOR-883) — Telegram only today.
 */
interface LeaveCapableAdapter {
  leaveChat(chatId: string): Promise<void>;
}

/**
 * Whether a live adapter instance exposes `leaveChat` at all. A structural
 * check rather than an `instanceof TelegramAdapter`, the same reasoning
 * {@link reportsVisibility} gives for `getMe` — so a future platform that
 * gains the same accessor works here without an import of its class.
 *
 * @param adapter - The live adapter instance from `AdapterRegistry.get`.
 */
export function canLeaveChat(adapter: RelayAdapter): adapter is RelayAdapter & LeaveCapableAdapter {
  return typeof (adapter as { leaveChat?: unknown }).leaveChat === 'function';
}
