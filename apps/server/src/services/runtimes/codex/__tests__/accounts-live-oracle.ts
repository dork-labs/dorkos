import assert from 'node:assert/strict';

/** Observed synthetic MCP call, recorded at the HTTP boundary. */
export interface AccountsCall {
  turn: number;
  name: string;
  args: { connectionId?: string; operationRevisionId?: string; arguments?: { query?: string } };
  dispatched: boolean;
}

/** Minimal event projection needed to distinguish grounded output from tool intent. */
export interface AccountsEvent {
  turn: number;
  event: { type: string; data?: { text?: string; toolName?: string; terminalReason?: string } };
}

/** Assert real discovery order, exact unread operation, fresh access and no revoked dispatch. */
export function assertAccountsConversation(
  calls: AccountsCall[],
  events: AccountsEvent[],
  deliveredContexts: Array<{ turn: number; zeroAccounts: boolean }> = []
): void {
  assert(calls.some((c) => c.turn === 1 && c.name === 'connectors.list_granted_connections'));
  for (const t of [2, 3]) {
    const selected = calls.findIndex((c) => c.turn === t && c.dispatched);
    assert(selected >= 0);
    assert(
      calls.some(
        (c, i) =>
          i < selected &&
          c.name === 'connectors.list_granted_operations' &&
          c.args.connectionId === calls[selected].args.connectionId
      ),
      'Read lacked prior matching schema discovery'
    );
    if (t === 3)
      assert(
        calls.some(
          (c, i) => i < selected && c.turn === 3 && c.name === 'connectors.list_granted_connections'
        ),
        'Changed access lacked fresh discovery'
      );
  }
  assert(
    calls.some((c) => c.turn === 4 && c.name === 'connectors.list_granted_connections') ||
      deliveredContexts.some((c) => c.turn === 4 && c.zeroAccounts),
    'Revoked turn lacked current inventory or delivered zero-account context'
  );
  assert(!calls.some((c) => c.turn === 4 && c.dispatched));
  for (const turn of [1, 2, 3, 4]) {
    const turnEvents = events.filter((e) => e.turn === turn);
    assert.equal(
      turnEvents.filter((e) => e.event.type === 'done').length,
      1,
      'Turn did not finish exactly once'
    );
    assert(
      turnEvents.some(
        (e) => e.event.type === 'session_status' && e.event.data?.terminalReason === 'completed'
      ),
      'Turn did not complete successfully'
    );
    assert(!turnEvents.some((e) => e.event.type === 'error'), 'Turn reported a runtime failure');
  }

  const prose = (t: number) =>
    events
      .filter((x) => x.turn === t && x.event.type === 'text_delta')
      .map((x) => x.event.data?.text ?? '')
      .join('');
  assert.match(prose(1), /Synthetic Inbox A|Gmail/i);
  assert(!calls.some((c) => c.turn === 1 && c.dispatched), 'Inventory question must not read mail');
  assert.match(prose(2), /Cobalt rehearsal/);
  assert.match(prose(3), /Amber rehearsal/);
  assert.match(prose(4), /access|permission|connect|grant|unavailable/i);
  assert(
    !/Cobalt rehearsal|Amber rehearsal/.test(prose(4)),
    'Revoked turn reused old mail as current'
  );
  assert(
    !events.some((x) =>
      JSON.stringify(x.event).match(/"toolName":"(?:exec_command|shell|Shell|Bash)"/)
    ),
    'Unexpected shell fallback'
  );

  const allowed = new Set([
    'connectors.list_granted_connections',
    'connectors.list_granted_operations',
    'connectors.execute_read',
  ]);
  assert(
    calls.every((c) => allowed.has(c.name)),
    'Unexpected owner inventory or tool call'
  );
  for (const call of calls.filter((c) => c.name === 'connectors.execute_read')) {
    assert.equal(call.args.operationRevisionId, 'fetch-unread-v1');
    assert.match(call.args.arguments?.query ?? '', /is:unread/);
  }
  assert.equal(calls.filter((c) => c.dispatched).length, 2);
  assert.equal(calls.filter((c) => c.name === 'connectors.execute_read').length, 2);
  assert.notEqual(
    calls.find((c) => c.turn === 2 && c.dispatched)?.args.connectionId,
    calls.find((c) => c.turn === 3 && c.dispatched)?.args.connectionId
  );
}
