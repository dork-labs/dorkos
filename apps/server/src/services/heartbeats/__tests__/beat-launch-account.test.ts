/**
 * The beat launcher passes the account a moved beat starts on to the launch,
 * as the send's `account` hint, and names none when the beat stays put.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatch = vi.hoisted(() => vi.fn());

vi.mock('../../session/launch/launch-session.js', () => ({
  dispatchSessionMessage: dispatch,
  isSessionLaunchRefusal: () => false,
}));

import { createBeatTurnLauncher } from '../beat-launch.js';

const REQUEST = {
  sessionId: 'beat-chat',
  messageId: 'beat-message',
  agentPath: '/agents/juno',
  runtime: 'claude-code',
  content: 'A heartbeat.',
  onSettled: () => undefined,
};

beforeEach(() => {
  dispatch.mockReset();
  dispatch.mockResolvedValue({ accepted: true, canonicalId: 'beat-chat' });
});

describe('the beat launcher and accounts', () => {
  it('sends the account a moved beat starts on', async () => {
    await createBeatTurnLauncher(() => undefined).launch({ ...REQUEST, account: 'claude5' });
    expect(dispatch.mock.calls[0]![0].request).toMatchObject({
      runtime: 'claude-code',
      account: 'claude5',
    });
  });

  it('names no account when the beat stays where its chat is', async () => {
    await createBeatTurnLauncher(() => undefined).launch(REQUEST);
    expect(dispatch.mock.calls[0]![0].request).not.toHaveProperty('account');
  });
});
