/**
 * Slack adapter compliance — the capability-driven sections of the shared suite
 * that pin Slack's echo prevention and message-splitting against the adapter's
 * real code.
 *
 * The Slack adapter is not headless-startable (`start()` opens a Socket-Mode
 * connection), so `startable: false` skips the lifecycle/delivery contract
 * checks and only the no-start capability checks run here.
 */
import { describe } from 'vitest';
import { SlackAdapter } from '../index.js';
import { SlackThreadIdCodec } from '../../../lib/thread-id.js';
import { splitMessage, SLACK_MAX_LENGTH } from '../../../lib/payload-utils.js';
import { runAdapterComplianceSuite } from '../../../testing/index.js';
import type { SlackAdapterConfig } from '../../../types.js';

const ADAPTER_ID = 'slack-compliance';
const CODEC = new SlackThreadIdCodec(ADAPTER_ID);

const SLACK_CONFIG: SlackAdapterConfig = {
  botToken: 'xoxb-fake-bot-token',
  appToken: 'xapp-fake-app-token',
  signingSecret: 'fake-signing-secret',
  streaming: true,
  nativeStreaming: true,
  typingIndicator: 'reaction',
  respondMode: 'thread-aware',
  dmPolicy: 'open',
  dmAllowlist: [],
  channelOverrides: {},
};

describe('Slack — capability compliance', () => {
  runAdapterComplianceSuite({
    name: 'SlackAdapter',
    createAdapter: () => new SlackAdapter(ADAPTER_ID, SLACK_CONFIG),
    deliverSubject: `${CODEC.prefix}.C0424242`,
    codec: CODEC,
    samplePlatformId: 'C0424242',
    capabilities: {
      // start() opens a Socket-Mode connection — skip the startable contract checks.
      startable: false,
      echoPrevention: {
        selfFrom: `${CODEC.prefix}.bot`,
        externalFrom: 'agent:external-sender',
      },
      messageSplitting: {
        limit: SLACK_MAX_LENGTH,
        split: (text) => splitMessage(text, SLACK_MAX_LENGTH),
        isValidChunk: (chunk) => chunk.length > 0 && chunk.length <= SLACK_MAX_LENGTH,
      },
    },
  });
});
