/**
 * `heartbeat.choose_triage_credits` (spec `heartbeats` §6.3, DOR-4978): a
 * person's answer to "Run cheap checks on DorkOS credits?". **Use credits**
 * (`useCredits: true`) sets `heartbeats.triageOnCredits` to `true`; **Not now**
 * sets it to `false`. Served by the capability mount on
 * `PUT /api/heartbeats/triage-credits` (ADR 261123-170830).
 *
 * It spends the account owner's credits, so:
 *
 * - **Only a person** (`http.audience: 'person'`), never an agent: no MCP
 *   surface, and the registry refuses any call without a person's proof.
 * - **Only the owner**: the mount runs the account owner bar every account
 *   write runs (`routes/cloud-owner-bar.ts`), before it reads the answer.
 * - **Use credits is confirm-first** (ADR 261125-114705, decision 4): it waits
 *   for the owner to confirm it's them on the "Confirm it's you" sheet, and the
 *   front-door and owner bars run again then. **Not now** stops spending, so it
 *   runs at once.
 * - **`person-held` from Wi-Fi**: the owner may say Not now from their phone,
 *   as they always could. Use credits from Wi-Fi is refused by the front-door
 *   bar before anything is held.
 *
 * The answer is a record row, written only when it changes the choice.
 *
 * @module services/heartbeats/triage/triage-credits-capability
 */
import { TriageCreditsChoiceSchema } from '@dorkos/shared/heartbeat-schemas';
import { defineCapability } from '../../core/capabilities/index.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';

/** Where the choice lives, set by the running server (`triage-mount.ts`). */
export interface TriageCreditsChoiceStore {
  /** `heartbeats.triageOnCredits` now. */
  choice(): boolean | null;
  /** Store the person's answer. */
  setChoice(useCredits: boolean): void;
  /** Record the change. */
  record(before: boolean | null, after: boolean): void;
}

/** Set by the running server; absent, the capability says heartbeats are not running. */
let store: TriageCreditsChoiceStore | undefined;

/**
 * Teach `heartbeat.choose_triage_credits` where the choice lives.
 *
 * @param next - The store, or undefined at shutdown.
 */
export function setTriageCreditsChoiceStore(next: TriageCreditsChoiceStore | undefined): void {
  store = next;
}

/** The capability; in the heartbeat domain. */
export const chooseTriageCreditsCapability = defineCapability({
  id: 'heartbeat.choose_triage_credits',
  title: 'Choose what pays for cheap checks',
  description:
    'The owner answers the offer to run cheap heartbeat checks on DorkOS credits: `true` uses ' +
    'credits, after the owner confirms it’s them; `false` keeps checks off credits. Only the ' +
    'owner, in the DorkOS app.',
  tier: 'act',
  area: null,
  areaNote: 'a person’s own account choice; no agent can call it',
  wifi: 'person-held',
  confirmFirst: {
    kind: 'cloud.credits',
    target: 'heartbeat-checks',
    reason: 'Use DorkOS credits for scheduled checks.',
    accountOwner: {
      personOnly: 'Only you can choose what pays for checks, from the DorkOS app.',
      action: 'choose what pays for checks',
    },
    when: (input) => input.useCredits,
  },
  input: TriageCreditsChoiceSchema,
  output: TriageCreditsChoiceSchema,
  surfaces: {
    http: { method: 'put', path: '/api/heartbeats/triage-credits', audience: 'person' },
  },
  invoke: async (_deps, { useCredits }) => {
    if (!store) {
      throw new CapabilityToolError({
        code: 'HEARTBEATS_UNAVAILABLE',
        error: 'Heartbeats are not running on this server yet.',
      });
    }
    const before = store.choice();
    store.setChoice(useCredits);
    if (before !== useCredits) store.record(before, useCredits);
    return { useCredits };
  },
});
