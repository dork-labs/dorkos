/** Producer provenance, not permission to recover: real SDK mapper channels. */
import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ErrorEvent, StreamEvent } from '@dorkos/shared/types';
import type { AgentSession, ToolState } from '../../agent-types.js';
import { runInDispatch } from '../../../../../lib/dispatch-context.js';
import { validatedRecoveryRoute } from '../../messaging/launch/required-launch.js';
import { retiredResult } from '../../sessions/diagnostics/retired-turn.js';
import { mapSdkMessage } from '../sdk-event-mapper.js';

async function turn(messages: Record<string, unknown>[], session = {} as AgentSession) {
  const tools = {
    toolNameById: new Map(),
    resolvedResultIds: new Set(),
    toolInputReceived: new Set(),
  } as unknown as ToolState;
  const events: StreamEvent[] = [];
  for (const message of messages) {
    for await (const event of mapSdkMessage(
      message as unknown as SDKMessage,
      session,
      'seat',
      tools
    )) {
      events.push(event);
    }
  }
  return events.filter((event) => event.type === 'error').map((event) => event.data as ErrorEvent);
}
const assistant = (error: string, text = 'API Error: upstream unavailable') => ({
  type: 'assistant',
  error,
  isApiErrorMessage: true,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const result = (errors: string[] = [], subtype = 'error_during_execution') => ({
  type: 'result',
  subtype,
  errors,
});
const marker = 'claude-server-error-terminal';

describe('Claude server-error terminal producer correlation', () => {
  it('marks only the wrapper of a structured server_error with exact notice echoes', async () => {
    const errors = await turn([
      assistant('server_error'),
      result(['API Error: upstream unavailable']),
    ]);
    expect(errors[0].code).toBe('server_error');
    expect(errors.at(-1)).toMatchObject({ code: 'error_during_execution', reason: marker });
  });
  it('permits an empty terminal diagnostic after the structured witness', async () => {
    expect((await turn([assistant('server_error'), result()])).at(-1)?.reason).toBe(marker);
  });
  it.each(['rate_limit', 'authentication_failed', 'invalid_request', 'unknown_future_error'])(
    'refuses a mixed %s diagnostic even if it is not surfaced',
    async (code) => {
      const errors = await turn([assistant('server_error'), assistant(code), result()]);
      expect(errors.some((error) => error.reason === marker)).toBe(false);
    }
  );
  it.each([
    [result(['API rate limit exceeded'])],
    [assistant('server_error'), result(['a different error'])],
    [assistant('server_error'), result([], 'error_max_turns')],
    [assistant('server_error'), result([], 'success')],
    [assistant('server_error'), { ...result(), terminal_reason: 'aborted_streaming' }],
  ])(
    'does not mark unrelated, protected, successful or interrupted results %#',
    async (...messages) => {
      expect((await turn(messages)).some((error) => error.reason === marker)).toBe(false);
    }
  );
  it('captures actual SDK-reported billing only for the exact room dispatch', async () => {
    const session = {
      launchedAccountRoot: '/accounts/exact',
      hasStarted: true,
      validatedRecoveryRoute: validatedRecoveryRoute('/accounts/exact', false, {}),
    } as AgentSession;
    await runInDispatch(
      { dispatchId: 'prior-dispatch', origin: 'room', entryId: 'prior-work' },
      () =>
        turn(
          [
            { type: 'system', subtype: 'init', session_id: 'seat', apiKeySource: 'oauth' },
            assistant('server_error'),
            result(),
          ],
          session
        )
    );
    expect(session.priorServerFailure).toEqual({
      dispatchId: 'prior-dispatch',
      entryId: 'prior-work',
      root: '/accounts/exact',
      inference: 'own-account',
      billing: 'subscription',
    });
  });
  it('does not treat SDK oauth/none as subscription proof on an alternate route', async () => {
    const session = {
      launchedAccountRoot: '/accounts/exact',
      hasStarted: true,
      validatedRecoveryRoute: validatedRecoveryRoute('/accounts/exact', false, {
        CLAUDE_CODE_USE_BEDROCK: '1',
      }),
    } as AgentSession;
    await runInDispatch(
      { dispatchId: 'prior-dispatch', origin: 'room', entryId: 'prior-work' },
      () =>
        turn(
          [
            { type: 'system', subtype: 'init', session_id: 'seat', apiKeySource: 'oauth' },
            assistant('server_error'),
            result(),
          ],
          session
        )
    );
    expect(session.priorServerFailure).toBeUndefined();
  });
  it('never promotes an environment prediction or unknown key source into actual billing proof', async () => {
    for (const apiKeySource of [undefined, 'unknown_future_source']) {
      const session = {
        launchedAccountRoot: '/accounts/exact',
        launchedPerToken: false,
        hasStarted: true,
      } as AgentSession;
      await runInDispatch(
        { dispatchId: 'prior-dispatch', origin: 'room', entryId: 'prior-work' },
        () =>
          turn(
            [
              { type: 'system', subtype: 'init', session_id: 'seat', apiKeySource },
              assistant('server_error'),
              result(),
            ],
            session
          )
      );
      expect(session.priorServerFailure).toBeUndefined();
    }
  });
  it('cannot carry a witness into the next turn on the same warm session', async () => {
    const session = {} as AgentSession;
    await turn([assistant('server_error'), result()], session);
    expect((await turn([result()], session)).at(-1)?.reason).not.toBe(marker);
  });
  it.each(['limit', 'ceiling', 'evict', 'shutdown'] as const)(
    'never promotes the actual protected %s retirement result',
    async (reason) => {
      const errors = await turn([
        assistant('server_error'),
        retiredResult('seat', reason) as unknown as Record<string, unknown>,
      ]);
      expect(errors.some((error) => error.reason === marker)).toBe(false);
    }
  );
});
