import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrototypeControl } from '../control.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(options = {}) {
  const events = [];
  const tab = {
    tabId: 'tab-a',
    browserId: 'browser-a',
    navigationGeneration: 0,
    viewportVersion: 1,
  };
  const manager = {
    getTab(id) {
      if (id !== tab.tabId) throw Error('unknown');
      return { ...tab };
    },
    async dispatchInput(id, action) {
      events.push(action.type);
    },
    async resetInput() {
      events.push('reset');
    },
    async closeBrowser() {
      events.push('close');
    },
  };
  const control = new PrototypeControl({
    manager,
    origin: 'http://localhost:1234',
    fixtureOrigin: 'http://localhost:9000',
    ...options,
  });
  const agent = control.issueParticipant({
    actorId: 'agent-a',
    kind: 'agent',
    tabIds: ['tab-a'],
    canControl: true,
  });
  const human = control.issueParticipant({
    actorId: 'human-a',
    kind: 'human',
    tabIds: ['tab-a'],
    canControl: true,
  });
  const watcher = control.issueParticipant({
    actorId: 'watch-a',
    kind: 'human',
    tabIds: ['tab-a'],
    canControl: false,
  });
  const request = (id = 'req-a', action = { type: 'click', x: 2, y: 3 }) => ({
    requestId: id,
    tabId: 'tab-a',
    navigationGeneration: 0,
    viewportVersion: 1,
    epoch: control.state('tab-a').epoch,
    action,
  });
  return { control, manager, events, tab, agent, human, watcher, request };
}

test('server token binds actor and observers cannot control', async () => {
  // Removing token binding would let agent-a choose human-a in this request.
  const s = setup();
  await s.control.acquire(s.agent, 'tab-a').barrier;
  assert.throws(
    () => s.control.submit(s.agent, { ...s.request(), actorId: 'human-a' }),
    /invalid-request/
  );
  assert.throws(() => s.control.acquire(s.watcher, 'tab-a'), /control-denied/);
  assert.equal(s.control.authorizeView(s.watcher, 'tab-a').actorId, 'watch-a');
  assert.throws(() => s.control.authorizeView('invalid', 'tab-a'), /unauthorized/);
  assert.equal((await s.control.submit(s.agent, s.request())).actorId, 'agent-a');
});

test('HTTP credential and exact origin guard fail closed', () => {
  const s = setup();
  assert.equal(
    s.control.authorizeRequest({
      authorization: `Bearer ${s.agent}`,
      origin: 'http://localhost:1234',
      fixtureOrigin: 'http://localhost:9000',
    }),
    s.agent
  );
  for (const origin of [undefined, 'null', 'http://attacker.test'])
    assert.throws(
      () => s.control.authorizeRequest({ authorization: `Bearer ${s.agent}`, origin }),
      /origin-denied/
    );
  for (const authorization of [undefined, 'Bearer bad', s.agent])
    assert.throws(
      () => s.control.authorizeRequest({ authorization, origin: 'http://localhost:1234' }),
      /unauthorized/
    );
});

test('navigation and viewport are checked at dispatch, not only admission', async () => {
  const s = setup();
  await s.control.acquire(s.agent, 'tab-a').barrier;
  const latch = deferred();
  const started = deferred();
  s.manager.dispatchInput = async (_, action) => {
    s.events.push(action.type);
    started.resolve();
    await latch.promise;
  };
  const first = s.control.submit(s.agent, s.request('first'));
  await started.promise;
  const second = s.control.submit(s.agent, s.request('second'));
  s.tab.navigationGeneration++;
  latch.resolve();
  assert.equal((await first).outcome, 'completed');
  assert.equal((await second).outcome, 'rejected');
  assert.deepEqual(s.events, ['reset', 'click']);
  s.tab.navigationGeneration = 0;
  s.tab.viewportVersion++;
  assert.equal((await s.control.submit(s.agent, s.request('viewport'))).outcome, 'rejected');
  assert.throws(
    () => s.control.submit(s.agent, { ...s.request(), tabId: 'tab-other' }),
    /view-denied/
  );
});

test('takeover cancels queued releases and composite steps then resets held input', async () => {
  // A removed epoch recheck causes keyUp/text from the old actor to reach the manager.
  const s = setup();
  await s.control.acquire(s.agent, 'tab-a').barrier;
  const latch = deferred();
  const started = deferred();
  const held = new Set();
  s.manager.dispatchInput = async (_, action) => {
    s.events.push(action.type);
    if (action.type === 'keyDown') {
      held.add(action.key);
      started.resolve();
      await latch.promise;
    }
    if (action.type === 'text') assert.equal(held.size, 0, 'first human input must be unmodified');
  };
  s.manager.resetInput = async () => {
    held.clear();
    s.events.push('reset');
  };
  const first = s.control.submit(
    s.agent,
    s.request('sequence', {
      type: 'sequence',
      steps: [
        { type: 'keyDown', key: 'Shift' },
        { type: 'text', text: 'old' },
      ],
    })
  );
  await started.promise;
  const release = s.control.submit(s.agent, s.request('release', { type: 'keyUp', key: 'Shift' }));
  const takeover = s.control.takeover(s.human, 'tab-a');
  assert.equal(s.control.state('tab-a').controllerId, 'human-a');
  const human = s.control.submit(s.human, s.request('human', { type: 'text', text: 'new' }));
  latch.resolve();
  await takeover.barrier;
  assert.equal((await first).outcome, 'aborted');
  assert.equal((await release).outcome, 'rejected');
  assert.equal((await human).outcome, 'completed');
  assert.deepEqual(s.events, ['reset', 'keyDown', 'reset', 'text']);
});

test('disconnect resets held mouse/composition before a new controller acts', async () => {
  const s = setup();
  await s.control.acquire(s.agent, 'tab-a').barrier;
  let held = false;
  s.manager.dispatchInput = async (_, action) => {
    s.events.push(action.type);
    if (action.type === 'mouseDown') held = true;
    if (action.type === 'mouseMove') assert.equal(held, false);
  };
  s.manager.resetInput = async () => {
    held = false;
    s.events.push('reset');
  };
  await s.control.submit(s.agent, s.request('down', { type: 'mouseDown', button: 'left' }));
  await Promise.all(s.control.disconnect(s.agent).map((x) => x.barrier));
  assert.throws(() => s.control.authorizeView(s.agent, 'tab-a'), /unauthorized/);
  await s.control.acquire(s.human, 'tab-a').barrier;
  assert.equal(
    (await s.control.submit(s.human, s.request('move', { type: 'mouseMove', x: 2, y: 3 }))).outcome,
    'completed'
  );
  assert.deepEqual(s.events, ['reset', 'mouseDown', 'reset', 'reset', 'mouseMove']);
});

test('blocked action takeover acknowledges immediately and closes browser at deadline', async () => {
  const s = setup({ barrierMs: 20, actionTimeoutMs: 100 });
  await s.control.acquire(s.agent, 'tab-a').barrier;
  const started = deferred();
  s.manager.dispatchInput = () => {
    started.resolve();
    return new Promise(() => {});
  };
  const old = s.control.submit(s.agent, s.request());
  await started.promise;
  const before = performance.now();
  const takeover = s.control.takeover(s.human, 'tab-a');
  assert.ok(performance.now() - before < 100);
  assert.equal((await takeover.barrier).status, 'stopped');
  assert.equal(s.control.state('tab-a').status, 'stopped');
  assert.equal(s.events.filter((x) => x === 'close').length, 1);
  assert.equal((await s.control.submit(s.human, s.request('human'))).outcome, 'rejected');
  assert.equal((await old).outcome, 'in-flight');
});

test('payloads, queue and action duration are bounded', async () => {
  const s = setup({ maxQueue: 1, actionTimeoutMs: 20 });
  await s.control.acquire(s.agent, 'tab-a').barrier;
  assert.throws(
    () =>
      s.control.submit(
        s.agent,
        s.request('large', {
          type: 'sequence',
          steps: Array.from({ length: 10 }, () => ({ type: 'text', text: 'x'.repeat(2000) })),
        })
      ),
    /payload-limit/
  );
  assert.throws(
    () => s.control.submit(s.agent, s.request('unknown', { type: 'evaluate', text: 'anything' })),
    /invalid-action/
  );
  const started = deferred();
  s.manager.dispatchInput = () => {
    started.resolve();
    return new Promise(() => {});
  };
  const first = s.control.submit(s.agent, s.request('first'));
  await started.promise;
  assert.throws(() => s.control.submit(s.agent, s.request('second')), /queue-full/);
  assert.equal((await first).outcome, 'in-flight');
  assert.equal(s.control.state('tab-a').status, 'stopped');
});

test('handoff requires the current controller and a target with explicit tab access', async () => {
  const s = setup();
  await s.control.acquire(s.agent, 'tab-a').barrier;
  assert.throws(() => s.control.handoff(s.human, 'tab-a', 'agent-a'), /not-controller/);
  assert.throws(() => s.control.handoff(s.agent, 'tab-a', 'watch-a'), /control-denied/);
  assert.throws(() => s.control.takeover(s.agent, 'tab-a'), /human-required/);
  const old = s.request('revoked');
  await s.control.handoff(s.agent, 'tab-a', 'human-a').barrier;
  assert.equal((await s.control.submit(s.agent, old)).outcome, 'rejected');
  assert.equal((await s.control.submit(s.human, s.request('human'))).outcome, 'completed');
  assert.deepEqual(s.events, ['reset', 'reset', 'click']);
});

test('reset failure stops input and manager tab removal preserves explicit stopped state', async () => {
  const s = setup();
  await s.control.acquire(s.agent, 'tab-a').barrier;
  s.manager.resetInput = async () => {
    throw Error('failure');
  };
  s.manager.closeBrowser = async () => {
    s.events.push('close');
    s.manager.getTab = () => {
      throw Error('tab-removed');
    };
  };
  assert.equal((await s.control.takeover(s.human, 'tab-a').barrier).status, 'stopped');
  assert.equal(s.control.state('tab-a').status, 'stopped');
  assert.equal((await s.control.submit(s.human, s.request('human'))).outcome, 'rejected');
  assert.deepEqual(s.events, ['reset', 'close']);
});

test('stalled reset and stalled shutdown cannot extend the takeover barrier', async () => {
  const s = setup({ barrierMs: 20 });
  await s.control.acquire(s.agent, 'tab-a').barrier;
  s.manager.resetInput = () => new Promise(() => {});
  s.manager.closeBrowser = () => new Promise(() => {});
  const start = performance.now();
  assert.equal((await s.control.takeover(s.human, 'tab-a').barrier).status, 'stopped');
  assert.ok(performance.now() - start < 100, 'reset deadline must not also await shutdown');
  assert.equal((await s.control.submit(s.human, s.request('human'))).outcome, 'rejected');
});

test('epoch recheck crosses the microtask boundary immediately before dispatch', async () => {
  const s = setup();
  await s.control.acquire(s.agent, 'tab-a').barrier;
  const getTab = s.manager.getTab;
  let schedule = true;
  let takeover;
  s.manager.getTab = (id) => {
    const result = getTab(id);
    if (schedule) {
      schedule = false;
      queueMicrotask(() => {
        takeover = s.control.takeover(s.human, 'tab-a');
      });
    }
    return result;
  };
  const result = await s.control.submit(s.agent, s.request('race'));
  await takeover.barrier;
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(s.events, ['reset', 'reset']);
});

test('caller mutation and composite navigation cannot retarget later steps', async () => {
  const s = setup();
  await s.control.acquire(s.agent, 'tab-a').barrier;
  s.manager.dispatchInput = async (_, action) => {
    s.events.push(action.type);
    if (action.type === 'navigate') s.tab.navigationGeneration++;
  };
  const request = s.request('navigation', {
    type: 'sequence',
    steps: [
      { type: 'navigate', url: 'http://localhost:9000/next' },
      { type: 'text', text: 'old-page' },
    ],
  });
  const promise = s.control.submit(s.agent, request);
  request.action.steps[0] = { type: 'text', text: 'mutation' };
  assert.equal((await promise).outcome, 'aborted');
  assert.deepEqual(s.events, ['reset', 'navigate']);
  assert.throws(
    () =>
      s.control.submit(
        s.agent,
        s.request('remote', { type: 'navigate', url: 'https://example.com' })
      ),
    /invalid-action/
  );
});

test('old epochs fail even when the controller is still the same actor', async () => {
  const s = setup();
  await s.control.acquire(s.agent, 'tab-a').barrier;
  const old = s.request('old-epoch');
  await s.control.handoff(s.agent, 'tab-a', 'agent-a').barrier;
  assert.equal((await s.control.submit(s.agent, old)).outcome, 'rejected');
  assert.equal((await s.control.submit(s.agent, s.request('new-epoch'))).outcome, 'completed');
  assert.deepEqual(s.events, ['reset', 'reset', 'click']);
});

test('an input failure resets possible held state before subsequent input', async () => {
  const s = setup();
  await s.control.acquire(s.agent, 'tab-a').barrier;
  let held = false;
  s.manager.dispatchInput = async (_, step) => {
    s.events.push(step.type);
    if (step.type === 'mouseDown') {
      held = true;
      throw Error('dispatch-lost');
    }
    assert.equal(held, false, 'next pointer action cannot inherit a failed held button');
  };
  s.manager.resetInput = async () => {
    held = false;
    s.events.push('reset');
  };
  assert.equal(
    (await s.control.submit(s.agent, s.request('failed', { type: 'mouseDown', button: 'left' })))
      .outcome,
    'failed'
  );
  assert.equal((await s.control.submit(s.agent, s.request('next'))).outcome, 'completed');
  assert.deepEqual(s.events, ['reset', 'mouseDown', 'reset', 'click']);
});

test('navigation is confined to the exact configured fixture origin', async () => {
  // Broad loopback permission would expose the operator's local DorkOS service.
  const s = setup({ fixtureOrigin: 'http://localhost:9000' });
  await s.control.acquire(s.agent, 'tab-a').barrier;
  for (const url of ['http://localhost:4242', 'http://127.0.0.1:9000', 'https://localhost:9000']) {
    assert.throws(
      () => s.control.submit(s.agent, s.request('other-service', { type: 'navigate', url })),
      /invalid-action/
    );
  }
  assert.equal(
    (
      await s.control.submit(
        s.agent,
        s.request('fixture', { type: 'navigate', url: 'http://localhost:9000/next' })
      )
    ).outcome,
    'completed'
  );
  assert.deepEqual(s.events, ['reset', 'navigate']);
});

test('an unseen tab inherits its stopped browser tombstone during stalled shutdown', async () => {
  // A tab discovered after stop must not create a new ready control seat for that process.
  const s = setup({ actionTimeoutMs: 20, barrierMs: 100 });
  await s.control.acquire(s.agent, 'tab-a').barrier;
  s.manager.dispatchInput = () => new Promise(() => {});
  s.manager.closeBrowser = () => new Promise(() => {});
  assert.equal((await s.control.submit(s.agent, s.request('blocked'))).outcome, 'in-flight');
  const getTab = s.manager.getTab;
  s.manager.getTab = (id) => (id === 'tab-unseen' ? { ...s.tab, tabId: id } : getTab(id));
  const newHuman = s.control.issueParticipant({
    actorId: 'human-unseen',
    kind: 'human',
    tabIds: ['tab-unseen'],
    canControl: true,
  });
  assert.equal(s.control.state('tab-unseen').status, 'stopped');
  assert.equal(s.control.state('tab-unseen').shutdownStatus, 'pending');
  assert.throws(() => s.control.acquire(newHuman, 'tab-unseen'), /browser-stopped/);
  assert.equal(
    (await s.control.submit(newHuman, { ...s.request('unseen'), tabId: 'tab-unseen' })).outcome,
    'rejected'
  );
  assert.deepEqual(s.events, ['reset']);
});

test('browser tombstones retain shutdown outcome and a fresh browser identity can recover', async () => {
  const s = setup({ actionTimeoutMs: 20 });
  await s.control.acquire(s.agent, 'tab-a').barrier;
  s.manager.dispatchInput = () => new Promise(() => {});
  s.manager.closeBrowser = async () => {
    throw Error('shutdown-failed');
  };
  await s.control.submit(s.agent, s.request('blocked'));
  await Promise.resolve();
  await Promise.resolve();
  s.manager.getTab = (id) => ({
    ...s.tab,
    tabId: id,
    browserId: id === 'tab-fresh' ? 'browser-fresh' : 'browser-a',
  });
  assert.equal(s.control.state('tab-later').shutdownStatus, 'failed');
  const fresh = s.control.issueParticipant({
    actorId: 'human-fresh',
    kind: 'human',
    tabIds: ['tab-fresh'],
    canControl: true,
  });
  s.manager.dispatchInput = async () => {
    s.events.push('fresh-input');
  };
  await s.control.acquire(fresh, 'tab-fresh').barrier;
  const state = s.control.state('tab-fresh');
  assert.equal(
    (
      await s.control.submit(fresh, {
        ...s.request('recovered'),
        tabId: 'tab-fresh',
        epoch: state.epoch,
      })
    ).outcome,
    'completed'
  );
  assert.equal(s.events.filter((x) => x === 'fresh-input').length, 1);
});
