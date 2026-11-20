/** Whether a chat's turn came from, or read words from, someone outside the team. */
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { roomTurnReadOutsideWords } from '../../core/turn-power/outside-words.js';
import { marksOf } from '../../core/turn-power/turn-levels.js';
import { turnStart, type TurnStart } from '../../core/turn-power/turn-start-marks.js';
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
  /** The turn's marks; a Wi-Fi sign-in's hold sets `outsider`, and so does a read (DOR-3969). */
  marksOf: typeof marksOf;
  /** How the turn STARTED: marked, clean, or not recorded. A read never changes it. */
  startedMarked: (sessionId: string) => TurnStart;
}

const LIVE_SOURCES: OutsideTurnSources = {
  agentPathOf: (sessionId) => runtimeRegistry.getSessionAgentPath(sessionId),
  launchOriginOf: (sessionId) => runtimeRegistry.getSessionLaunchOrigin(sessionId),
  marksOf,
  startedMarked: turnStart,
};

/**
 * Which mark makes this chat's turn an outsider's, or null for none: a stranger started the chat,
 * its latest turn holds outside words from a room or another chat, the turn started marked (a
 * Wi-Fi sign-in's hold, a carried mark), or only a read during the turn marked it (DOR-4693).
 * Startup hands it to the browser handoff, which lets the last of these through for a page DorkOS
 * saw refuse the browser.
 *
 * @param sources - Overrides for tests; the live server's otherwise.
 */
export function liveOutsideTurnCheck(sources: Partial<OutsideTurnSources> = {}): OutsideTurnCheck {
  const {
    agentPathOf,
    launchOriginOf,
    marksOf: turnMarksOf,
    startedMarked,
  } = { ...LIVE_SOURCES, ...sources };
  return async (sessionId) => {
    let launchOrigin: string | null = null;
    try {
      launchOrigin = launchOriginOf(sessionId);
    } catch {
      // No database (early boot): nothing stored to read.
    }
    if (launchOrigin !== null && STRANGER_LAUNCH_ORIGINS.has(launchOrigin)) return 'stranger_chat';
    if (roomTurnReadOutsideWords(sessionId)) return 'room_outside_words';
    // Read first: a continuation of a held turn carries no mark of its own, but is that turn.
    const start = startedMarked(sessionId);
    if (start === 'marked') return 'outsider_turn';
    const agentPath = await agentPathOf(sessionId).catch(() => null);
    if (turnMarksOf(sessionId, agentPath ?? undefined).outsider !== true) return null;
    // Only a start recorded clean makes the mark a read's; no record fails closed.
    return start === 'clean' ? 'read_outside_text' : 'outsider_turn';
  };
}
