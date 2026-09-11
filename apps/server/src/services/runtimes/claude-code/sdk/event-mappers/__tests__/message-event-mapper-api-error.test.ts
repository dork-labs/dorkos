/**
 * The live path's handling of an API-error assistant message (DOR-1832).
 *
 * The CLI files the API's content safeguard under the same `invalid_request`
 * code as a malformed request, and the live mapper used to hand the client
 * "The request was rejected as invalid." with NO details — so the person saw
 * "Agent stopped unexpectedly" and had nothing to act on, while the reload
 * path (`api-error-record.ts`) kept the CLI's text. Both paths now say the
 * same thing and both keep the raw notice, request id included.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mapMessageEvent } from '../message-event-mapper.js';
import { SAFEGUARD_REFUSAL_MESSAGE, SURFACED_ASSISTANT_ERRORS } from '../../sdk-error-mapping.js';
import type { AgentSession, ToolState } from '../../../agent-types.js';
import type { ErrorEvent } from '@dorkos/shared/types';

vi.mock('../../../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SAFEGUARD_NOTICE =
  "API Error: Opus 5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup). Our intentionally broad safeguards allow us to deliver more capabilities faster, but can sometimes flag legitimate coding, cybersecurity, and biology tasks. Claude Code can't respond to this message with Opus 5 (1M context).\n\nTry rephrasing the request in a new session or change your model.\n\nRequest ID: req_011CenTMwsusUFUgkzHGbSR4";

function apiErrorMessage(error: string, text: string | undefined): SDKMessage {
  return {
    type: 'assistant',
    isApiErrorMessage: true,
    error,
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: text === undefined ? [] : [{ type: 'text', text }],
    },
  } as unknown as SDKMessage;
}

async function errorEvents(message: SDKMessage): Promise<ErrorEvent[]> {
  const session = { sdkSessionId: null, hasStarted: true } as unknown as AgentSession;
  const toolState = {
    toolNameById: new Map(),
    resolvedResultIds: new Set(),
    toolInputReceived: new Set(),
  } as unknown as ToolState;
  const out: ErrorEvent[] = [];
  for await (const e of mapMessageEvent(message, session, toolState)) {
    if (e.type === 'error') out.push(e.data as ErrorEvent);
  }
  return out;
}

describe('live API-error assistant message', () => {
  it('names the safeguard refusal and keeps the raw notice with its request id', async () => {
    const [event] = await errorEvents(apiErrorMessage('invalid_request', SAFEGUARD_NOTICE));

    expect(event).toEqual({
      message: SAFEGUARD_REFUSAL_MESSAGE,
      code: 'invalid_request',
      category: 'execution_error',
      details: SAFEGUARD_NOTICE,
    });
    expect(SAFEGUARD_REFUSAL_MESSAGE).toContain('https://www.anthropic.com/legal/aup');
  });

  it('keeps the plain sentence for an invalid request that is not a safeguard', async () => {
    const [event] = await errorEvents(
      apiErrorMessage(
        'invalid_request',
        'API Error: 400 messages: text content blocks must be non-empty'
      )
    );

    expect(event.message).toBe('The request was rejected as invalid.');
    expect(event.details).toBe('API Error: 400 messages: text content blocks must be non-empty');
  });

  it('emits no details when the CLI wrote no text', async () => {
    const [event] = await errorEvents(apiErrorMessage('server_error', undefined));

    expect(event.message).toBe('Claude encountered a server error. Try again in a moment.');
    expect(event).not.toHaveProperty('details');
  });
});

/**
 * The three values `SDKAssistantMessageError` gained across SDK 0.3.224 →
 * 0.3.268. `SURFACED_ASSISTANT_ERRORS` is a hand-maintained set and the mapper
 * drops anything absent from it, so before these were added a person whose
 * account went on hold, needed verification, or whose cloud credentials were
 * refused got no card at all — the turn simply ended.
 */
describe('the assistant errors added in SDK 0.3.268', () => {
  it('tells someone their Claude account is on hold', async () => {
    const [event] = await errorEvents(apiErrorMessage('account_on_hold', undefined));

    expect(event.message).toContain('on hold');
    expect(event.code).toBe('account_on_hold');
    expect(event.category).toBe('execution_error');
  });

  it('tells someone their Claude account needs verifying', async () => {
    const [event] = await errorEvents(apiErrorMessage('verification_required', undefined));

    expect(event.message).toContain('verified');
    expect(event.code).toBe('verification_required');
    expect(event.category).toBe('execution_error');
  });

  it('points a refused cloud credential at Settings, not at signing in again', async () => {
    const [event] = await errorEvents(apiErrorMessage('cloud_credential_error', undefined));

    expect(event.message).toContain('cloud credentials');
    expect(event.message).toContain('Settings');
    expect(event.code).toBe('cloud_credential_error');
    // NOT `auth_error`: that category earns the client's "Fix sign-in" button,
    // and signing in again cannot repair a Bedrock/Vertex/Foundry credential.
    expect(event.category).toBe('execution_error');
  });

  it('keeps the CLI’s own words when it wrote any', async () => {
    const [event] = await errorEvents(
      apiErrorMessage('account_on_hold', 'API Error: account is on hold. Request ID: req_42')
    );

    expect(event.details).toBe('API Error: account is on hold. Request ID: req_42');
  });

  it('surfaces every value the set names', async () => {
    for (const code of SURFACED_ASSISTANT_ERRORS) {
      const [event] = await errorEvents(apiErrorMessage(code, undefined));
      expect(event, `${code} is in the set but produced no card`).toBeDefined();
      expect(
        event.message,
        `${code} falls through to the default sentence, which tells a person nothing`
      ).not.toBe('The agent stopped with an unexpected error.');
    }
  });
});
