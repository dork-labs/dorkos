/**
 * The UI suite. Phase 2 ships `widget-round-trip` — the ONE product eval that
 * runs on `test-mode` (free), because `POST /api/sessions/:id/ui-action` is
 * runtime-agnostic: it starts a real new turn with NO model prompt (spec §6
 * eval #7 + note 7, the keystone finding). The judgment-tier `control_ui` /
 * `switch-agent` evals — which need a real model to CHOOSE the `control_ui` tool
 * — land in Phase 3.
 *
 * @module evals/suite/ui
 */
import type { EvalCase } from '../types.js';
import { uiActionTriggerObserved } from '../oracles/stream.js';

/** The widget action id the round-trip asserts flows through to a new turn. */
const ROUND_TRIP_ACTION_ID = 'confirm-round-trip';

/**
 * `widget-round-trip` — drive the generative-UI return channel end-to-end on
 * `test-mode`. The runner drives the seed prompt to establish the session, then
 * POSTs a widget `agent`-action to `/ui-action`; the injected `<ui_action>`
 * block rides the new turn's `turn_start.userMessage`, which the oracle asserts.
 * Free, deterministic, and in the `smoke` subset — the first real product eval
 * the harness can run without a credentialed runtime.
 */
export const widgetRoundTripCase: EvalCase = {
  id: 'widget-round-trip',
  title: 'Widget round-trip — a widget action starts a new turn carrying its payload',
  // A seed turn so the session exists (a widget can only be clicked after a
  // turn rendered it). test-mode answers deterministically and free; the widget
  // action below is the eval's real input.
  prompt: 'Render a widget I can interact with.',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['core', 'smoke'],
  widgetAction: {
    actionId: ROUND_TRIP_ACTION_ID,
    widgetTitle: 'Round-trip probe',
    payload: { choice: 'yes' },
  },
  oracles: [
    uiActionTriggerObserved(ROUND_TRIP_ACTION_ID, 'widget action reached the agent as a new turn'),
  ],
};
