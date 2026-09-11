import { describe, expect, it } from 'vitest';
import {
  assertAccountsConversation,
  type AccountsCall,
  type AccountsEvent,
} from './accounts-live-oracle.js';

function valid() {
  const calls: AccountsCall[] = [
    { turn: 1, name: 'connectors.list_granted_connections', args: {}, dispatched: false },
  ];
  calls.push(
    ...[2, 3].flatMap((turn) => [
      { turn, name: 'connectors.list_granted_connections', args: {}, dispatched: false },
      {
        turn,
        name: 'connectors.list_granted_operations',
        args: { connectionId: `account-${turn}` },
        dispatched: false,
      },
      {
        turn,
        name: 'connectors.execute_read',
        args: {
          connectionId: `account-${turn}`,
          operationRevisionId: 'fetch-unread-v1',
          arguments: { query: 'is:unread' },
        },
        dispatched: true,
      },
    ])
  );
  calls.push({ turn: 4, name: 'connectors.list_granted_connections', args: {}, dispatched: false });
  const events: AccountsEvent[] = [
    'Gmail: Synthetic Inbox A',
    'Cobalt rehearsal',
    'Amber rehearsal',
    'No account access is granted.',
  ].map((text, index) => ({ turn: index + 1, event: { type: 'text_delta', data: { text } } }));
  for (const turn of [1, 2, 3, 4])
    events.push(
      { turn, event: { type: 'session_status', data: { terminalReason: 'completed' } } },
      { turn, event: { type: 'done' } }
    );
  return { calls, events };
}

describe('CN-01/CN-05/CN-07/CN-10 live conversation outcome oracle', () => {
  it('accepts unhinted inventory discovery, two grounded reads, and revocation', () => {
    const { calls, events } = valid();
    expect(() => assertAccountsConversation(calls, events)).not.toThrow();
  });
  it('allows reuse of unchanged account inventory and trusts delivered zero-account context', () => {
    const { calls, events } = valid();
    const withoutRedundantInventory = calls.filter(
      (c) => !(c.name === 'connectors.list_granted_connections' && [2, 4].includes(c.turn))
    );
    expect(() =>
      assertAccountsConversation(withoutRedundantInventory, events, [
        { turn: 4, zeroAccounts: true },
      ])
    ).not.toThrow();
  });
  it.each([
    'profile',
    'failed-profile-then-correct',
    'no-schema',
    'stale-inventory',
    'revoked-dispatch',
    'stale-prose',
    'shell',
    'no-revoked-discovery',
    'aborted-turn',
    'terminal-error',
    'no-opening-discovery',
    'opening-mail-read',
    'owner-inventory',
    'ungrounded-opening',
    'stale-changed-account',
  ])('rejects %s even if the model says it succeeded', (failure) => {
    const { calls, events } = valid();
    const firstRead = calls.find((c) => c.dispatched)!;
    const remove = (turn: number, name: string) =>
      calls.splice(
        calls.findIndex((c) => c.turn === turn && c.name === name),
        1
      );
    if (failure === 'profile') firstRead.args.operationRevisionId = 'profile-v1';
    if (failure === 'failed-profile-then-correct')
      calls.splice(3, 0, {
        ...firstRead,
        dispatched: false,
        args: { ...firstRead.args, operationRevisionId: 'profile-v1' },
      });
    if (failure === 'no-schema') remove(2, 'connectors.list_granted_operations');
    if (failure === 'stale-inventory') remove(3, 'connectors.list_granted_connections');
    if (failure === 'revoked-dispatch') calls.push({ ...firstRead, turn: 4 });
    if (failure === 'stale-prose') events[3]!.event.data!.text = 'Account access: Cobalt rehearsal';
    if (failure === 'no-revoked-discovery') remove(4, 'connectors.list_granted_connections');
    if (failure === 'aborted-turn')
      events.splice(
        events.findIndex((e) => e.turn === 4 && e.event.type === 'done'),
        1
      );
    if (failure === 'terminal-error') events.push({ turn: 4, event: { type: 'error' } });
    if (failure === 'shell')
      events.push({ turn: 1, event: { type: 'tool_call_start', data: { toolName: 'Shell' } } });
    if (failure === 'no-opening-discovery') remove(1, 'connectors.list_granted_connections');
    if (failure === 'opening-mail-read') calls.push({ ...firstRead, turn: 1 });
    if (failure === 'owner-inventory')
      calls.push({ turn: 1, name: 'connectors.list_owner_accounts', args: {}, dispatched: false });
    if (failure === 'stale-changed-account')
      for (const call of calls.filter((c) => c.turn === 3 && c.args.connectionId))
        call.args.connectionId = firstRead.args.connectionId;
    if (failure === 'ungrounded-opening') events[0]!.event.data!.text = 'I can access Slack.';
    expect(() => assertAccountsConversation(calls, events)).toThrow();
  });
});
