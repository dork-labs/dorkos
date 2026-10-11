/**
 * The server's own heartbeat triage, built once at startup: rung 1 on DorkOS
 * credits over the real credits modules, the fuse's counter, and the record row
 * for a change of source (spec `heartbeats` §6.3).
 *
 * Every port reads live state on each beat: the person's choice in config, the
 * kill switch, the link, the held token and the service's model list. A test
 * builds `CreditsTriage` with fakes instead and never comes here.
 *
 * @module services/decisions/triage-wiring
 */
import { recordAudit } from '../audit/audit-trail.js';
import { configManager } from '../core/config-manager.js';
import { creditsCanBeHad, creditsKilled } from '../core/cloud/credits-availability.js';
import { heldCreditsToken } from '../core/cloud/credits-inference.js';
import { creditsModelsFor } from '../core/cloud/credits-models.js';
import { setHeartbeatTriage } from './heartbeat-triage.js';
import { CreditsTriage, type TriageSource, type TriageSourceReason } from './triage-credits.js';

/** Why checks left credits, in words for the record. */
const REASON_WORDS: Record<TriageSourceReason, string> = {
  credits: 'Checks run on DorkOS credits again.',
  'not-chosen': 'Credits are no longer chosen for checks.',
  'switched-off': 'Credits are switched off on this computer.',
  'not-linked': 'This computer is no longer linked to a DorkOS account.',
  'no-token': 'DorkOS credits could not be reached.',
  'not-served': 'DorkOS credits do not serve checks right now.',
  'no-model': 'DorkOS credits name no model for checks right now.',
  refused: 'DorkOS credits refused the check.',
  fuse: 'Checks reached today’s limit on credits.',
};

/**
 * Write the one record row for a change of where checks run. Never names the
 * token: the row carries the two places and why.
 *
 * @param from - Where checks ran.
 * @param to - Where they run now.
 */
export function recordTriageSourceChange(from: TriageSource, to: TriageSource): void {
  recordAudit({
    source: { surface: 'system' },
    action: 'heartbeat.triage_source_changed',
    operation: 'execute',
    target: { type: 'setting', id: 'heartbeats.triageOnCredits' },
    outcome: 'ok',
    change: [{ field: 'runsOn', before: from.runsOn, after: to.runsOn }],
    reason: to.reason,
    summary:
      to.runsOn === 'credits'
        ? REASON_WORDS.credits
        : `Checks moved to each agent’s own runtime. ${REASON_WORDS[to.reason]}`,
    visibility: 'space',
  });
}

/** The model the service recommends on `openaiChat`, or null. Never throws. */
async function recommendedChatModel(): Promise<string | null> {
  try {
    const models = await creditsModelsFor('openai-chat-completions');
    return models.find((model) => model.recommendedOn?.includes('openaiChat'))?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the server's credits triage and hand it to `triageBeat`.
 *
 * @param opts - Requests already sent today (UTC), from the beat record, so a
 *   restart does not reset the fuse.
 * @param opts.requestsToday - That count.
 * @returns The credits triage, for the Heartbeat page's live line.
 */
export function startHeartbeatTriage(opts: { requestsToday?: number } = {}): CreditsTriage {
  const triage = new CreditsTriage(
    {
      choice: () => configManager.get('heartbeats').triageOnCredits ?? null,
      killed: creditsKilled,
      linked: creditsCanBeHad,
      token: heldCreditsToken,
      recommendedModel: recommendedChatModel,
      fetch: (url, init) => globalThis.fetch(url, init),
      recordSourceChange: recordTriageSourceChange,
    },
    { requestsToday: opts.requestsToday ?? 0 }
  );
  setHeartbeatTriage({ creditsModel: () => triage.bridge(), counter: triage.counter });
  return triage;
}

/** Forget the server's credits triage, at shutdown. */
export function stopHeartbeatTriage(): void {
  setHeartbeatTriage(undefined);
}
