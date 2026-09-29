/**
 * A scripted turn that asks the owner for an app mid-chat (DOR-2415), so a
 * browser can drive the chat card without a model.
 *
 * The turn says it needs Gmail and records a held `request_connection` call in
 * the transcript, exactly as Claude Code names it, then parks. The test opens
 * the matching REAL request through `POST /api/test/connectors/request` (same
 * session, same arguments), which is what the card reads; the scripted call is
 * only the anchor in the transcript. One `POST /api/test/step` ends the call
 * and lets the turn carry on, the way a real held call returns once the owner
 * answers.
 *
 * Deliberately absent from `features.testModeScenarios`, like the other gated
 * fixtures: it parks on a step barrier only its own test releases.
 *
 * @module services/runtimes/test-mode/connection-request-scenarios
 */
import type { StreamEvent } from '@dorkos/shared/types';
import type { ScenarioFn } from './scenario-store.js';

/** Session id stamped on the synthetic status events, matching the other families. */
const SCENARIO_SESSION_ID = 'test-mode';

/** The call as Claude Code records a `dorkos` server tool. */
const TOOL_NAME = 'mcp__dorkos__connectors.request_connection';

/**
 * The arguments the scripted call records. A test opening the real request
 * must send these same values, since a held call is matched to its request by
 * service, reason and actions.
 *
 * Slack, not Gmail, on purpose: it is one of the scripted provider's two apps
 * and the only one no other Connections case signs in to or removes, so this
 * turn's card starts from a state the test controls.
 */
export const CONNECTION_REQUEST_SCENARIO_INPUT = {
  version: 1,
  serviceSlug: 'slack',
  reason: 'Summarise today’s messages',
  access: 'read',
  requestedEvents: [],
} as const;

const connectionRequest: ScenarioFn = async function* (_content, ctx) {
  const toolCallId = `connection-request-${ctx.sessionId}`;
  yield {
    type: 'text_delta',
    data: { text: 'I’d need your Slack for that. Asking you now.\n\n' },
  } as StreamEvent;
  yield {
    type: 'tool_call_start',
    data: { toolCallId, toolName: TOOL_NAME, status: 'running' },
  } as StreamEvent;
  yield {
    type: 'tool_call_delta',
    data: {
      toolCallId,
      toolName: TOOL_NAME,
      input: JSON.stringify(CONNECTION_REQUEST_SCENARIO_INPUT),
      status: 'running',
    },
  } as StreamEvent;
  await ctx.awaitStep();
  yield {
    type: 'tool_call_end',
    data: { toolCallId, toolName: TOOL_NAME, status: 'complete', result: 'The owner answered.' },
  } as StreamEvent;
  yield {
    type: 'text_delta',
    data: { text: 'Here’s today in Slack: three threads need you.' },
  } as StreamEvent;
  yield { type: 'done', data: { sessionId: SCENARIO_SESSION_ID } } as StreamEvent;
};

/**
 * Connection-request scenarios keyed by the name accepted at
 * `POST /api/test/scenario`. Merged into the test-mode scenario registry.
 */
export const CONNECTION_REQUEST_SCENARIOS: Record<string, ScenarioFn> = {
  'connection-request': connectionRequest,
};
