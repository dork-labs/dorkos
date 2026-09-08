/** Independent receive visibility never asks for owner authority or prints an unscoped response. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/api-client.js', () => ({
  apiCall: vi.fn(),
  ApiError: class extends Error {},
  getServerBaseUrl: () => 'http://localhost:4242',
}));
import { apiCall } from '../../lib/api-client.js';
import { runConnectionsDispatcher } from '../connections.js';
const api = vi.mocked(apiCall);
const subscription = {
  id: 'sub-a',
  connectionId: 'account-a',
  definitionId: 'definition-a',
  eventType: 'NEW_MAIL',
  displayName: 'New mail',
  deliveryMode: 'unknown',
  expectedCadenceSeconds: null,
  agentId: 'agent/a',
  destination: { kind: 'agent', id: 'agent/a' },
  filter: { label: 'Work' },
  scopeVersion: 1,
  state: 'active',
  toolkit: 'gmail',
  label: 'Work mail',
};
const page = { agentId: 'agent/a', subscriptions: [subscription] };
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('connections subscriptions', () => {
  it.each([
    [],
    ['--agent', ' '],
    ['--agent', 'agent/a', '--limit', '101'],
    ['--agent', 'agent/a', '--owner', 'other'],
    ['--agent', 'agent/a', 'extra'],
  ])('requires explicit bounded scope before any request: %j', async (...args) => {
    expect(await runConnectionsDispatcher(['subscriptions', ...args])).toBe(1);
    expect(api).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
  });
  it('requests only the read route with encoded agent and cursor and validates JSON', async () => {
    api.mockResolvedValue(page);
    expect(
      await runConnectionsDispatcher([
        'subscriptions',
        '--agent',
        ' agent/a ',
        '--cursor',
        'a/b',
        '--limit',
        '7',
        '--json',
      ])
    ).toBe(0);
    expect(api).toHaveBeenCalledExactlyOnceWith(
      'GET',
      '/api/connectors/accessible/subscriptions?agentId=agent%2Fa&cursor=a%2Fb&limit=7'
    );
    expect(process.stdout.write).toHaveBeenCalledWith(`${JSON.stringify(page, null, 2)}\n`);
  });
  it.each([
    { ...page, agentId: 'other', subscriptions: [{ ...subscription, agentId: 'other' }] },
    { ...page, subscriptions: [{ ...subscription, agentId: 'other' }] },
    { ...page, subscriptions: [{ ...subscription, providerTriggerRef: 'private' }] },
    { ...page, subscriptions: [{ ...subscription, content: 'private' }] },
  ])('prints no JSON when a response is foreign or contains private fields', async (response) => {
    api.mockResolvedValue(response);
    expect(await runConnectionsDispatcher(['subscriptions', '--agent', 'agent/a', '--json'])).toBe(
      1
    );
    expect(process.stdout.write).not.toHaveBeenCalled();
  });
  it('labels unknown timing honestly and removes terminal control characters from labels', async () => {
    api.mockResolvedValue({
      ...page,
      subscriptions: [{ ...subscription, label: 'Work\u001b[31m' }],
      nextCursor: 'next',
    });
    expect(await runConnectionsDispatcher(['subscriptions', '--agent', 'agent/a'])).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Timing unknown'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Work [31m'));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('\u001b'));
    expect(console.log).toHaveBeenCalledWith('\nNext cursor: next');
  });
});
