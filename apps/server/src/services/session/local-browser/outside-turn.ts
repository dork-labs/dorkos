/** Whether a chat's turn came from, or read words from, someone outside the team. */
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { roomTurnReadOutsideWords } from '../../core/turn-power/outside-words.js';
import { marksOf } from '../../core/turn-power/turn-levels.js';
import type { OutsideTurnCheck } from './handover.js';

/**
 * Launch origins whose every turn is a stranger's: a bridged Telegram or Slack
 * chat, an outside agent, or a connected app's event. DOR-3440 retired the
 * per-turn origin notes, so the chat's stored launch origin is what is left.
 */
const STRANGER_LAUNCH_ORIGINS: ReadonlySet<string> = new Set([
  'relay-binding',
  'outside-sender',
  'connector-event',
]);

/** What {@link liveOutsideTurnCheck} reads; the live server's by default. */
export interface OutsideTurnSources {
  /** The chat's agent home. */
  agentPathOf: (sessionId: string) => Promise<string | null>;
  /** The chat's stored launch origin, or null when none is stored. */
  launchOriginOf: (sessionId: string) => string | null;
}

const LIVE_SOURCES: OutsideTurnSources = {
  agentPathOf: (sessionId) => runtimeRegistry.getSessionAgentPath(sessionId),
  launchOriginOf: (sessionId) => runtimeRegistry.getSessionLaunchOrigin(sessionId),
};

/**
 * A stranger started the chat, its latest room turn answered someone outside
 * this machine, or a Wi-Fi sign-in's hold marks the turn. Startup hands it to
 * the browser handoff.
 *
 * @param sources - Overrides for tests; the live server's otherwise.
 */
export function liveOutsideTurnCheck(sources: Partial<OutsideTurnSources> = {}): OutsideTurnCheck {
  const { agentPathOf, launchOriginOf } = { ...LIVE_SOURCES, ...sources };
  return async (sessionId) => {
    let launchOrigin: string | null = null;
    try {
      launchOrigin = launchOriginOf(sessionId);
    } catch {
      // No database (early boot): nothing stored to read.
    }
    if (launchOrigin !== null && STRANGER_LAUNCH_ORIGINS.has(launchOrigin)) return true;
    if (roomTurnReadOutsideWords(sessionId)) return true;
    const agentPath = await agentPathOf(sessionId).catch(() => null);
    return marksOf(sessionId, agentPath ?? undefined).outsider === true;
  };
}
