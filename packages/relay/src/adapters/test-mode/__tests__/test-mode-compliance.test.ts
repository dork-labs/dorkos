/**
 * Test-mode relay adapter compliance.
 *
 * The test-mode adapter is a runtime fixture, not a channel adapter: it starts
 * headlessly (no network), so the startable lifecycle checks run, but it does
 * not render relay StreamEvents to an external platform, so
 * `rendersStreamEvents: false` skips the channel StreamEvent-rendering checks.
 */
import { describe } from 'vitest';
import { TestModeRelayAdapter } from '../test-mode-relay-adapter.js';
import type { RuntimeOutboundEvent } from '../../runtime-adapter.js';
import { runAdapterComplianceSuite } from '../../../testing/index.js';

const SESSION = 'compliance-session';

const SCENARIOS: RuntimeOutboundEvent[] = [
  { type: 'text_delta', data: { text: 'Echo: compliance' } },
  { type: 'done', data: { sessionId: SESSION } },
];

describe('Test Mode — relay adapter compliance', () => {
  runAdapterComplianceSuite({
    name: 'TestModeRelayAdapter',
    createAdapter: () => new TestModeRelayAdapter({ scenarios: SCENARIOS }),
    deliverSubject: `relay.agent.test-mode.${SESSION}`,
    capabilities: {
      startable: true,
      rendersStreamEvents: false,
    },
  });
});
