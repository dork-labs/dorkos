import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import type { Page, CDPSession } from 'playwright-core';
import { SupervisedSemanticReader } from '../native-reader.js';

// Portable original-receiver protocol doubles. These are not Chromium/frame/native allocation proof.
const owned: SupervisedSemanticReader[] = [];
const releases: (() => void)[] = [];
const expectedTerminal = new Map<SupervisedSemanticReader, unknown>();
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  const originals = owned.splice(0);
  const results = await Promise.allSettled(originals.map((owner) => owner.close()));
  vi.restoreAllMocks();
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    const original = originals[index]!;
    if (
      result.status === 'rejected' &&
      !(expectedTerminal.has(original) && Object.is(expectedTerminal.get(original), result.reason))
    )
      throw result.reason;
  }
  expectedTerminal.clear();
});
const identity = {
  version: 1 as const,
  browserId: 'AAAAAAAAAAAAAAAAAAAAAA',
  browserGeneration: 1,
  tabId: 'BBBBBBBBBBBBBBBBBBBBBB',
  navigationGeneration: 0,
  viewportVersion: 0,
  treeId: 'CCCCCCCCCCCCCCCCCCCCCC',
  treeRevision: 0,
  epoch: 0,
  inputGeneration: 0,
  grantRevision: 1,
};
const actor = 'DDDDDDDDDDDDDDDDDDDDDD',
  grant = 'EEEEEEEEEEEEEEEEEEEEEE';
function fixture() {
  const document = { nodeType: 9 };
  let element = {
    nodeType: 1,
    localName: 'input',
    type: 'text',
    isConnected: true,
    ownerDocument: document,
    value: 'hello',
    disabled: false,
    readOnly: false,
  };
  let name = 'Field',
    description = 'plain',
    role = 'textfield',
    axFocused = false,
    wide = 0,
    depth = 0,
    nativeFrameChildren = 0;
  const objects = new Map<string, object>([
    ['document', document],
    ['observer', { close() {} }],
  ]);
  let nextObject = 0;
  const sessionEvents = new EventEmitter();
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    switch (method) {
      case 'Page.getFrameTree':
        return {
          frameTree: {
            frame: { id: 'native-main' },
            ...(nativeFrameChildren
              ? {
                  childFrames: Array.from({ length: nativeFrameChildren }, (_, index) => ({
                    frame: { id: 'native-child-' + index },
                  })),
                }
              : {}),
          },
        };
      case 'Target.getTargetInfo':
        return { targetInfo: { targetId: 'owned-target', type: 'page' } };
      case 'Page.createIsolatedWorld':
        return { executionContextId: 1 };
      case 'Runtime.evaluate':
        return params.expression === 'document'
          ? { result: { objectId: 'document' } }
          : { result: { objectId: 'observer' } };
      case 'Accessibility.getRootAXNode':
        return {
          node: {
            nodeId: 'root',
            backendDOMNodeId: 1,
            role: { value: role },
            properties: [
              {
                name: 'focused',
                value: { type: 'boolean', value: axFocused },
              },
            ],
            name: { value: name },
            description: { value: description },
            childIds: wide || depth ? ['children'] : [],
          },
        };
      case 'Accessibility.getChildAXNodes':
        return {
          nodes: wide
            ? Array.from({ length: wide }, (_, index) => ({
                nodeId: 'child' + index,
                role: { value: 'StaticText' },
                name: { value: 'x' },
                childIds: [],
              }))
            : depth
              ? [
                  {
                    nodeId: 'depth' + params.id,
                    role: { value: 'generic' },
                    ignored: true,
                    childIds: String(params.id).length < depth ? ['next'] : [],
                  },
                ]
              : [],
        };
      case 'DOM.describeNode':
        if (params.objectId !== 'document') throw new Error('unexpected document receiver');
        return { node: { backendNodeId: 2 } };
      case 'DOM.resolveNode': {
        const objectId = 'object' + ++nextObject;
        objects.set(objectId, element);
        return { object: { objectId } };
      }
      case 'Runtime.callFunctionOn': {
        const receiver = objects.get(String(params.objectId));
        const args = ((params.arguments ?? []) as { objectId: string }[]).map((arg) =>
          objects.get(arg.objectId)
        );
        const original = runInNewContext('(' + params.functionDeclaration + ')', {
          document,
          TextEncoder,
        });
        return { result: { value: Reflect.apply(original, receiver, args) } };
      }
      case 'Accessibility.getPartialAXTree':
        return {
          nodes: [
            {
              nodeId: 'root',
              backendDOMNodeId: 1,
              role: { value: role },
              properties: [
                {
                  name: 'focused',
                  value: { type: 'boolean', value: axFocused },
                },
              ],
              name: { value: name },
              childIds: wide || depth ? ['children'] : [],
            },
          ],
        };
      default:
        return {};
    }
  });
  const session = {
    send,
    on: sessionEvents.on.bind(sessionEvents),
    off: sessionEvents.off.bind(sessionEvents),
    detach: vi.fn(async () => {}),
  } as unknown as CDPSession;
  const events = new EventEmitter();
  const main = {};
  const members: object[] = [main],
    targets = new Map<object, CDPSession>();
  const context = {
    newCDPSession: vi.fn(async (subject: object) => targets.get(subject) ?? session),
  };
  const page = {
    context: () => context,
    frames: () => members,
    mainFrame: () => main,
    isClosed: () => false,
    on: events.on.bind(events),
    off: events.off.bind(events),
  } as unknown as Page;
  const owner = new SupervisedSemanticReader(page);
  owned.push(owner);
  return {
    owner,
    send,
    session,
    events,
    sessionEvents,
    frames(count: number) {
      nativeFrameChildren = count;
    },
    attach(target: CDPSession) {
      const frame = { isDetached: () => false };
      members.push(frame);
      targets.set(frame, target);
    },
    focusThroughShadow(axReportsFocused = true) {
      axFocused = axReportsFocused;
      Object.assign(document, {
        activeElement: { shadowRoot: { activeElement: element } },
        hasFocus: () => true,
      });
    },
    get element() {
      return element;
    },
    replace() {
      element = { ...element };
    },
    name(value: string) {
      name = value;
    },
    description(value: string) {
      description = value;
    },
    role(value: string) {
      role = value;
    },
    wide(value: number) {
      wide = value;
    },
    deep(value: number) {
      depth = value;
    },
  };
}
it('uses exact original target/frame methods and issues bounded nonauthoritative output', async () => {
  const f = fixture();
  const snapshot = await f.owner.read(identity, actor, grant);
  expect(snapshot.nodes[0]).toMatchObject({
    role: 'textbox',
    value: 'hello',
    actions: ['focus', 'insertText', 'replaceText', 'key'],
  });
  expect(snapshot.nodes[0]?.nodeRef).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(262144);
  expect(f.send).toHaveBeenCalledWith('Accessibility.getRootAXNode', {
    frameId: 'native-main',
  });
  expect(
    f.send.mock.calls.some(
      ([method]) => method === 'Accessibility.getFullAXTree' || method === 'DOM.getDocument'
    )
  ).toBe(false);
});
it('does not rebind an identical replacement to an issued ref', async () => {
  const f = fixture();
  const first = await f.owner.read(identity, actor, grant);
  f.element.isConnected = false;
  f.replace();
  f.element.isConnected = true;
  expect(await f.owner.resolve(first.semanticLeaseId, first.nodes[0]!.nodeRef, actor, grant)).toBe(
    false
  );
  const second = await f.owner.read(identity, actor, grant);
  expect(second.nodes[0]?.nodeRef).not.toBe(first.nodes[0]?.nodeRef);
});
it('fresh native role/name mismatch refuses an old object even without a dirty hint', async () => {
  const f = fixture();
  const first = await f.owner.read(identity, actor, grant);
  f.name('replacement role label');
  expect(await f.owner.resolve(first.semanticLeaseId, first.nodes[0]!.nodeRef, actor, grant)).toBe(
    false
  );
});
it('drops secure value before projection and omits secure descendant extraction', async () => {
  const f = fixture();
  f.element.type = 'password';
  Object.defineProperty(f.element, 'value', {
    get() {
      throw new Error('SECRET_VALUE_READ');
    },
  });
  f.name('password secret sentinel');
  f.wide(2001);
  const snapshot = await f.owner.read(identity, actor, grant);
  expect(snapshot.nodes[0]).toMatchObject({
    name: 'Password field',
    redacted: true,
    editKind: 'secret',
  });
  expect(JSON.stringify(snapshot)).not.toContain('password secret sentinel');
  expect(snapshot.nodes[0]).not.toHaveProperty('value');
  expect(f.send.mock.calls.some(([method]) => method === 'Accessibility.getChildAXNodes')).toBe(
    false
  );
});
it('omits remote markup descriptions and strips override characters', async () => {
  const f = fixture();
  f.name('safe\u202Elabel');
  f.description('<img src=x onerror=evil()>');
  const snapshot = await f.owner.read(identity, actor, grant);
  expect(snapshot.nodes[0]?.name).toBe('safelabel');
  expect(snapshot.nodes[0]).not.toHaveProperty('description');
});
it('wide and deep candidates truncate without actionable refs', async () => {
  const wide = fixture();
  wide.wide(2001);
  const snapshot = await wide.owner.read(identity, actor, grant);
  expect(snapshot.completeness).toBe('truncated');
  expect(snapshot.nodes.every((node) => node.actions.length === 0)).toBe(true);
  if (snapshot.nodes[0])
    expect(
      await wide.owner.resolve(snapshot.semanticLeaseId, snapshot.nodes[0].nodeRef, actor, grant)
    ).toBe(false);
  const deep = fixture();
  deep.deep(1000);
  const tree = await deep.owner.read(identity, actor, grant);
  expect(tree.completeness).toBe('truncated');
  expect(tree.nodes.length).toBeLessThanOrEqual(2000);
});
it('dirty/frame changes synchronously revoke every prior actor lease', async () => {
  const f = fixture();
  const snapshot = await f.owner.read(identity, actor, grant);
  f.sessionEvents.emit('Accessibility.nodesUpdated', {});
  expect(
    await f.owner.resolve(snapshot.semanticLeaseId, snapshot.nodes[0]!.nodeRef, actor, grant)
  ).toBe(false);
});
it('wrong actor/grant cannot borrow references', async () => {
  const f = fixture();
  const snapshot = await f.owner.read(identity, actor, grant);
  expect(
    await f.owner.resolve(
      snapshot.semanticLeaseId,
      snapshot.nodes[0]!.nodeRef,
      'FFFFFFFFFFFFFFFFFFFFFF',
      grant
    )
  ).toBe(false);
  expect(
    await f.owner.resolve(
      snapshot.semanticLeaseId,
      snapshot.nodes[0]!.nodeRef,
      actor,
      'GGGGGGGGGGGGGGGGGGGGGG'
    )
  ).toBe(false);
});
it('retains original held acquisition through deadline and terminal close', async () => {
  const f = fixture();
  let release!: () => void, enter!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  releases.push(release);
  const actual = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (method, params) => {
    if (method === 'Page.getFrameTree') {
      enter();
      await held;
    }
    return actual(method, params);
  });
  const read = f.owner.read(identity, actor, grant);
  await entered;
  let closed = false;
  const close = f.owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await expect(read).rejects.toThrow();
  await close;
  expect(closed).toBe(true);
});

it('enforces five actual extraction starts per second and two-second lease expiry', async () => {
  let now = 10000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const f = fixture();
  const first = await f.owner.read(identity, actor, grant);
  for (let n = 0; n < 4; n++) await f.owner.read(identity, actor, grant);
  await expect(f.owner.read(identity, actor, grant)).rejects.toThrow('SEMANTIC_RATE');
  now += 2001;
  expect(await f.owner.resolve(first.semanticLeaseId, first.nodes[0]!.nodeRef, actor, grant)).toBe(
    false
  );
});

it('refuses the ninth unexpired actor lease without evicting the first', async () => {
  let now = 10000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const f = fixture();
  const first = await f.owner.read(identity, actor, grant);
  for (const elapsed of [200, 400, 600, 800, 1001, 1200, 1400]) {
    now = 10000 + elapsed;
    await f.owner.read(identity, actor, grant);
  }
  now = 11600;
  await expect(f.owner.read(identity, actor, grant)).rejects.toThrow('SEMANTIC_LEASE_CAPACITY');
  now = 11801;
  expect(await f.owner.resolve(first.semanticLeaseId, first.nodes[0]!.nodeRef, actor, grant)).toBe(
    true
  );
});

it('registers a genuine separate target receiver and never resolves its IDs through the parent', async () => {
  const f = fixture();
  const child = fixture();
  const original = child.send.getMockImplementation()!;
  child.send.mockImplementation(async (method, params) =>
    method === 'Page.getFrameTree'
      ? { frameTree: { frame: { id: 'oopif-native' } } }
      : method === 'Target.getTargetInfo'
        ? { targetInfo: { targetId: 'oopif-target', type: 'iframe' } }
        : original(method, params)
  );
  f.attach(child.session);
  const snapshot = await f.owner.read(identity, actor, grant);
  expect(new Set(snapshot.nodes.map((node) => node.frameId)).size).toBe(2);
  expect(snapshot.nodes[0]!.actions.length).toBeGreaterThan(0);
  expect(snapshot.nodes[1]!.actions.length).toBeGreaterThan(0);
  expect(child.send).toHaveBeenCalledWith('Accessibility.getRootAXNode', {
    frameId: 'oopif-native',
  });
  expect(
    f.send.mock.calls.some(
      ([method, args]) =>
        method === 'Accessibility.getRootAXNode' && args?.frameId === 'oopif-native'
    )
  ).toBe(false);
});

it('fresh disconnected-object inspection refuses a reference without any dirty hint', async () => {
  const f = fixture();
  const snapshot = await f.owner.read(identity, actor, grant);
  f.element.isConnected = false;
  expect(
    await f.owner.resolve(snapshot.semanticLeaseId, snapshot.nodes[0]!.nodeRef, actor, grant)
  ).toBe(false);
});

it('frame/document replacement cannot inherit a prior generation or lease', async () => {
  const f = fixture();
  const first = await f.owner.read(identity, actor, grant);
  f.events.emit('framenavigated', {});
  const second = await f.owner.read(identity, actor, grant);
  expect(second.nodes[0]?.frameId).toBe(first.nodes[0]?.frameId);
  expect(second.nodes[0]?.frameNavigationGeneration).toBe(
    first.nodes[0]!.frameNavigationGeneration + 1
  );
  expect(second.nodes[0]?.nodeRef).not.toBe(first.nodes[0]?.nodeRef);
  expect(await f.owner.resolve(first.semanticLeaseId, first.nodes[0]!.nodeRef, actor, grant)).toBe(
    false
  );
});

it('resolves the connected focused element through a genuine inspector shadow-root chain', async () => {
  const f = fixture();
  f.focusThroughShadow();
  const snapshot = await f.owner.read(identity, actor, grant);
  expect(snapshot.focusedRef).toBe(snapshot.nodes[0]!.nodeRef);
  expect(
    await f.owner.resolve(snapshot.semanticLeaseId, snapshot.nodes[0]!.nodeRef, actor, grant)
  ).toBe(true);
});
it('keeps inspector-only focus unmapped when the original AX node does not corroborate it', async () => {
  const f = fixture();
  f.focusThroughShadow(false);
  const snapshot = await f.owner.read(identity, actor, grant);
  expect(snapshot.focusedRef).toBeNull();
  expect(snapshot.focusState).toBe('unmapped');
});
it('caps exact original native frames with one original listener per session/event and retires every replaced frame', async () => {
  const f = fixture();
  f.frames(33);
  const snapshot = await f.owner.read(identity, actor, grant);
  expect(snapshot.completeness).toBe('truncated');
  expect(new Set(snapshot.nodes.map((node) => node.frameId)).size).toBe(32);
  expect(snapshot.nodes.every((node) => node.actions.length === 0)).toBe(true);
  expect(
    await f.owner.resolve(snapshot.semanticLeaseId, snapshot.nodes[0]!.nodeRef, actor, grant)
  ).toBe(false);
  const events = ['DOM.documentUpdated', 'Accessibility.nodesUpdated', 'Runtime.bindingCalled'];
  for (const event of events) expect(f.sessionEvents.listenerCount(event)).toBe(1);
  expect(f.sessionEvents.getMaxListeners()).toBe(10);
  // One genuine target event invalidates all 32 original frame records, not only the first.
  f.sessionEvents.emit('DOM.documentUpdated');
  const replaced = await f.owner.read(identity, actor, grant);
  expect(replaced.nodes).toHaveLength(snapshot.nodes.length);
  for (const previous of snapshot.nodes) {
    const successor = replaced.nodes.find((node) => node.frameId === previous.frameId);
    expect(successor).toBeDefined();
    expect(successor!.frameNavigationGeneration).toBe(previous.frameNavigationGeneration + 1);
    expect(successor!.nodeRef).not.toBe(previous.nodeRef);
  }
  for (const event of events) expect(f.sessionEvents.listenerCount(event)).toBe(1);
  await f.owner.close();
  for (const event of events) expect(f.sessionEvents.listenerCount(event)).toBe(0);
  expect(f.session.detach).toHaveBeenCalled();
});
it('bounds UTF-8 labels and refuses oversized plain text as editable material', async () => {
  const f = fixture();
  f.name('é'.repeat(600));
  f.element.value = 'é'.repeat(1100);
  const snapshot = await f.owner.read(identity, actor, grant);
  expect(Buffer.byteLength(snapshot.nodes[0]!.name)).toBeLessThanOrEqual(512);
  expect(snapshot.nodes[0]!.editKind).toBe('unsupported');
  expect(snapshot.nodes[0]).not.toHaveProperty('value');
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(262144);
});

it('preregisters the original extraction before send reenters close and holds metadata', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  const original = f.send.getMockImplementation()!;
  let closing: Promise<void> | undefined,
    settled = false;
  f.send.mockImplementation(async (method, params = {}) => {
    if (method === 'Page.getFrameTree') {
      closing = f.owner.close();
      void closing.then(() => {
        settled = true;
      });
      await held;
    }
    return original(method, params);
  });
  const entered = f.owner.read(identity, actor, grant);
  void entered.catch(() => {});
  await vi.waitFor(() => expect(closing).toBeDefined());
  expect(settled).toBe(false);
  await expect(f.owner.read(identity, actor, grant)).rejects.toThrow('SEMANTIC_BUSY');
  release();
  await expect(entered).rejects.toThrow('SEMANTIC_UNAVAILABLE');
  await closing;
  expect(settled).toBe(true);
  expect(f.send.mock.calls.some(([method]) => method === 'Runtime.evaluate')).toBe(false);
});

it('retains an original falsy isolated-world rejection through reader closure', async () => {
  const f = fixture();
  const original = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (method, params = {}) => {
    if (method === 'Page.createIsolatedWorld') throw undefined;
    return original(method, params);
  });
  await expect(f.owner.read(identity, actor, grant)).rejects.toBeUndefined();
  expectedTerminal.set(f.owner, undefined);
  await expect(f.owner.close()).rejects.toBeUndefined();
  expect(f.send.mock.calls.some(([method]) => method === 'Accessibility.getRootAXNode')).toBe(
    false
  );
});

it('refuses a public extraction while exact original reference revalidation is held', async () => {
  const f = fixture();
  const snapshot = await f.owner.read(identity, actor, grant);
  const original = f.send.getMockImplementation()!;
  let release!: () => void, enter!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  f.send.mockImplementation(async (method, params = {}) => {
    if (
      method === 'Runtime.callFunctionOn' &&
      String(params.functionDeclaration).includes('ownerDocument')
    ) {
      enter();
      await held;
    }
    return original(method, params);
  });
  const resolving = f.owner.resolve(
    snapshot.semanticLeaseId,
    snapshot.nodes[0]!.nodeRef,
    actor,
    grant
  );
  void resolving.catch(() => {});
  await entered;
  const before = f.send.mock.calls.length;
  await expect(f.owner.read(identity, actor, grant)).rejects.toThrow('SEMANTIC_BUSY');
  expect(f.send.mock.calls.length).toBe(before);
  release();
  expect(await resolving).toBe(true);
});
it('retains a dirty-frame original off failure and enters no replacement target producer', async () => {
  const f = fixture();
  f.frames(33);
  const attempts: string[] = [];
  const off = f.session.off.bind(f.session);
  f.session.off = ((event: string, listener: (...args: unknown[]) => void) => {
    attempts.push(event);
    Reflect.apply(off, f.session, [event, listener]);
    if (event === 'DOM.documentUpdated') throw undefined;
    return f.session;
  }) as CDPSession['off'];
  await f.owner.read(identity, actor, grant);
  f.events.emit('framenavigated');
  const acquisitions = f.send.mock.calls.filter(
    ([method]) => method === 'Page.getFrameTree'
  ).length;
  await expect(f.owner.read(identity, actor, grant)).rejects.toBeUndefined();
  expectedTerminal.set(f.owner, undefined);
  expect(f.send.mock.calls.filter(([method]) => method === 'Page.getFrameTree').length).toBe(
    acquisitions
  );
  await expect(f.owner.close()).rejects.toBeUndefined();
  expect(f.session.detach).toHaveBeenCalled();
  expect(attempts.sort()).toEqual([
    'Accessibility.nodesUpdated',
    'DOM.documentUpdated',
    'Runtime.bindingCalled',
  ]);
  for (const event of attempts) expect(f.sessionEvents.listenerCount(event)).toBe(0);
});

it('retains the exact original native backend/frame target only for the captured actor and grant lease', async () => {
  const f = fixture();
  f.focusThroughShadow();
  const snapshot = await f.owner.read(identity, actor, grant),
    node = snapshot.nodes[0]!;
  const target = await f.owner.target(snapshot.semanticLeaseId, node.nodeRef, actor, grant);
  expect(target).toMatchObject({
    nativeTargetId: 'owned-target',
    nativeFrameId: 'native-main',
    backendNodeId: 1,
    documentBackendNodeId: 2,
    nodeRef: node.nodeRef,
    focused: true,
    kind: 'plainText',
  });
  expect(
    await f.owner.target(
      snapshot.semanticLeaseId,
      node.nodeRef,
      'foreign_actor_fixture_0001',
      grant
    )
  ).toBeNull();
  expect(f.send).toHaveBeenCalledWith('DOM.describeNode', { objectId: 'document' });
  const beforeForeign = f.send.mock.calls.length;
  expect(
    await f.owner.target(
      snapshot.semanticLeaseId,
      node.nodeRef,
      actor,
      'foreign_grant_fixture_0001'
    )
  ).toBeNull();
  expect(f.send.mock.calls.length).toBe(beforeForeign);
  f.element.isConnected = false;
  f.replace();
  f.element.isConnected = true;
  expect(await f.owner.target(snapshot.semanticLeaseId, node.nodeRef, actor, grant)).toBeNull();
});

it('refuses a malformed native document backend without inventing a target identity', async () => {
  const f = fixture();
  f.focusThroughShadow();
  const snapshot = await f.owner.read(identity, actor, grant),
    node = snapshot.nodes[0]!;
  const original = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (method, params = {}) =>
    method === 'DOM.describeNode' ? { node: { backendNodeId: 0 } } : original(method, params)
  );
  await expect(
    f.owner.target(snapshot.semanticLeaseId, node.nodeRef, actor, grant)
  ).rejects.toThrow();
  f.send.mockImplementation(original);
  expect(await f.owner.target(snapshot.semanticLeaseId, node.nodeRef, actor, grant)).toMatchObject({
    backendNodeId: 1,
    documentBackendNodeId: 2,
  });
});
