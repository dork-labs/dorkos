import { expect, it, onTestFinished, vi } from 'vitest';
import {
  SemanticSnapshotV1Schema,
  SemanticReceiptV1Schema,
  SemanticEventV1Schema,
  type SemanticActionV1,
} from '@dorkos/shared/browser-semantic-schemas';
import type { BrowserSemanticTransport, BrowserSemanticScope } from '@dorkos/shared/transport';
import { SemanticOutlineSession } from '../model/semantic-outline-session';
const scope: BrowserSemanticScope = {
  binding: {
    browserId: 'browser_fixture_000000001',
    browserGeneration: 1,
    tabId: 'tab_fixture_00000000000001',
    navigationGeneration: 0,
    viewportVersion: 0,
    epoch: 0,
    inputGeneration: 0,
  },
  grant: { grantId: 'grant_fixture_000000000001', revision: 1 },
};
const snapshot = () =>
  SemanticSnapshotV1Schema.parse({
    version: 1,
    ...scope.binding,
    treeId: 'semantic_tree_fixture_0001',
    treeRevision: 1,
    grantRevision: 1,
    semanticLeaseId: 'semantic_lease_fixture_001',
    capturedAt: new Date().toISOString(),
    expiresInMs: 2000,
    rootRefs: [],
    nodes: [],
    focusedRef: null,
    focusState: 'none',
    focusRevision: 0,
    completeness: 'complete',
  });
// Named delivery doubles establish original local lifetime custody, not server/native readiness.
it('close joins the held original read and enters no late stream birth', async () => {
  const bank: {
    release?: () => void;
    session?: SemanticOutlineSession;
    reading?: Promise<void>;
    closing?: Promise<void>;
  } = {};
  onTestFinished(async () => {
    bank.release?.();
    if (bank.reading) await Promise.allSettled([bank.reading]);
    if (bank.session) await bank.session.close();
  });
  const held = new Promise<void>((resolve) => {
    bank.release = resolve;
  });
  const stream = vi.fn<BrowserSemanticTransport['openBrowserSemanticStream']>(async () => {
    throw new Error('LATE_STREAM_ENTERED');
  });
  const delivery: BrowserSemanticTransport = {
    readBrowserSemantic: async () => {
      await held;
      return snapshot();
    },
    openBrowserSemanticStream: stream,
    actionBrowserSemantic: async () => {
      throw new Error('UNUSED_ACTION');
    },
  };
  const session = (bank.session = new SemanticOutlineSession(
    delivery,
    scope,
    () => undefined,
    new AbortController().signal
  ));
  const reading = (bank.reading = session.read());
  void reading.catch(() => {});
  await Promise.resolve();
  let closed = false;
  const closing = (bank.closing = session.close());
  void closing.then(() => {
    closed = true;
  });
  for (let index = 0; index < 8; index++) await Promise.resolve();
  expect(closed).toBe(false);
  expect(stream).not.toHaveBeenCalled();
  bank.release!();
  await expect(reading).rejects.toThrow('SEMANTIC_LOCAL_CANCELLED');
  await closing;
  expect(stream).not.toHaveBeenCalled();
  expect(session.snapshot().snapshot).toBeUndefined();
});
it('never enters a producer at mount and revoked local ownership refuses a later read', async () => {
  const read = vi.fn<BrowserSemanticTransport['readBrowserSemantic']>(async () => snapshot());
  const loss = new AbortController();
  const session = new SemanticOutlineSession(
    {
      readBrowserSemantic: read,
      openBrowserSemanticStream: async () => {
        throw new Error('UNUSED_STREAM');
      },
      actionBrowserSemantic: async () => {
        throw new Error('UNUSED_ACTION');
      },
    },
    scope,
    () => undefined,
    loss.signal
  );
  onTestFinished(() => session.close());
  expect(read).not.toHaveBeenCalled();
  loss.abort();
  await expect(session.read()).rejects.toThrow('SEMANTIC_LOCAL_CLOSED');
  expect(read).not.toHaveBeenCalled();
  await session.close();
});

it('a synchronous pending notification can revoke local ownership before the original read enters', async () => {
  const loss = new AbortController();
  const read = vi.fn<BrowserSemanticTransport['readBrowserSemantic']>(async () => snapshot());
  const session = new SemanticOutlineSession(
    {
      readBrowserSemantic: read,
      openBrowserSemanticStream: async () => {
        throw new Error('UNENTERED_STREAM');
      },
      actionBrowserSemantic: async () => {
        throw new Error('UNENTERED_ACTION');
      },
    },
    scope,
    () => undefined,
    loss.signal
  );
  const unsubscribe = session.subscribe(() => {
    if (session.snapshot().pending) loss.abort();
  });
  onTestFinished(async () => {
    unsubscribe();
    await session.close();
  });
  await expect(session.read()).rejects.toThrow('SEMANTIC_LOCAL_CANCELLED');
  expect(read).not.toHaveBeenCalled();
});
it('close reserves its exact original promise before synchronous notification reentry', async () => {
  const session = new SemanticOutlineSession(
    {
      readBrowserSemantic: async () => snapshot(),
      openBrowserSemanticStream: async () => {
        throw new Error('UNENTERED_STREAM');
      },
      actionBrowserSemantic: async () => {
        throw new Error('UNENTERED_ACTION');
      },
    },
    scope,
    () => undefined,
    new AbortController().signal
  );
  const bank: { reentered?: Promise<void> } = {};
  const unsubscribe = session.subscribe(() => {
    bank.reentered = session.close();
  });
  onTestFinished(async () => {
    unsubscribe();
    await session.close();
  });
  const original = session.close();
  await original;
  expect(bank.reentered).toBe(original);
});

it('immediate close fences a previously queued read before its original transport enters', async () => {
  const read = vi.fn<BrowserSemanticTransport['readBrowserSemantic']>(async () => snapshot());
  const session = new SemanticOutlineSession(
    {
      readBrowserSemantic: read,
      openBrowserSemanticStream: async () => {
        throw new Error('UNENTERED_STREAM');
      },
      actionBrowserSemantic: async () => {
        throw new Error('UNENTERED_ACTION');
      },
    },
    scope,
    () => undefined,
    new AbortController().signal
  );
  onTestFinished(() => session.close());
  const original = session.read();
  void original.catch(() => {});
  const closing = session.close();
  await expect(original).rejects.toThrow('SEMANTIC_LOCAL_CANCELLED');
  await closing;
  expect(read).not.toHaveBeenCalled();
});

it('a captured original stream next getter can close without entering its native producer', async () => {
  const bank: { session?: SemanticOutlineSession; original?: Promise<void> } = {};
  onTestFinished(async () => {
    if (bank.original) await Promise.allSettled([bank.original]);
    if (bank.session) await bank.session.close();
  });
  const next = vi.fn(async () => null);
  const stream = {
    eventStreamId: 'semantic_stream_fixture_001',
    get next() {
      void bank.session!.close().catch(() => {});
      return next;
    },
    close: async () => {},
  };
  const session = (bank.session = new SemanticOutlineSession(
    {
      readBrowserSemantic: async () => snapshot(),
      openBrowserSemanticStream: async () => stream,
      actionBrowserSemantic: async () => {
        throw new Error('UNENTERED_ACTION');
      },
    },
    scope,
    () => undefined,
    new AbortController().signal
  ));
  const original = (bank.original = session.read());
  void original.catch(() => {});
  await expect(original).rejects.toThrow('SEMANTIC_LOCAL_CANCELLED');
  await session.close();
  expect(next).not.toHaveBeenCalled();
  expect(session.snapshot().snapshot).toBeUndefined();
});

it('boxes an original controller callback undefined inside action work and fences later original producers', async () => {
  const bank: {
    session?: SemanticOutlineSession;
    operation?: Promise<void>;
    accepted: boolean;
  } = {
    accepted: false,
  };
  onTestFinished(async () => {
    if (bank.operation) await Promise.allSettled([bank.operation]);
    if (bank.session) {
      try {
        await bank.session.close();
      } catch (value) {
        if (!bank.accepted || value !== undefined) throw value;
      }
    }
  });
  const node = {
    nodeRef: 'semantic_node_button_001',
    frameId: 'semantic_frame_fixture_001',
    frameNavigationGeneration: 0,
    parentRef: null,
    childRefs: [],
    role: 'button',
    name: 'Continue',
    states: {},
    editKind: 'none',
    actions: ['activate'],
    redacted: false,
    truncated: false,
  };
  const value = SemanticSnapshotV1Schema.parse({
    ...snapshot(),
    rootRefs: [node.nodeRef],
    nodes: [node],
  });
  const read = vi.fn<BrowserSemanticTransport['readBrowserSemantic']>(async () => value);
  const mutation = vi.fn<BrowserSemanticTransport['actionBrowserSemantic']>(async () => {
    throw new Error('UNENTERED_ACTION');
  });
  let refuse = false;
  const controller = vi.fn(() => {
    if (refuse) throw undefined;
    return 'controller_fixture_000001';
  });
  const session = (bank.session = new SemanticOutlineSession(
    {
      readBrowserSemantic: read,
      actionBrowserSemantic: mutation,
      openBrowserSemanticStream: async (_scope, _lease, signal) => ({
        eventStreamId: 'semantic_stream_fixture_001',
        next: () =>
          new Promise<null>((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
        close: async () => {},
      }),
    },
    scope,
    controller,
    new AbortController().signal
  ));
  bank.operation = session.read();
  await bank.operation;
  refuse = true;
  const operation = (bank.operation = session.act(value.nodes[0], {
    kind: 'activate',
  }));
  await expect(operation).rejects.toBeUndefined();
  bank.accepted = true;
  await expect(session.read()).rejects.toBeUndefined();
  expect(read).toHaveBeenCalledTimes(1);
  expect(mutation).not.toHaveBeenCalled();
  await expect(session.close()).rejects.toBeUndefined();
  const count = controller.mock.calls.length;
  await expect(session.act(value.nodes[0], { kind: 'activate' })).rejects.toBeUndefined();
  expect(controller).toHaveBeenCalledTimes(count);
  const healthyControl = vi.fn(() => 'controller_fixture_000001');
  const stopped = new SemanticOutlineSession(
    {
      readBrowserSemantic: read,
      actionBrowserSemantic: mutation,
      openBrowserSemanticStream: async () => {
        throw new Error('UNENTERED_STREAM');
      },
    },
    scope,
    healthyControl,
    new AbortController().signal
  );
  onTestFinished(() => stopped.close());
  await stopped.close();
  await expect(stopped.act(value.nodes[0], { kind: 'activate' })).rejects.toThrow(
    'SEMANTIC_ACTION_REFUSED'
  );
  expect(healthyControl).not.toHaveBeenCalled();
});

function plainSnapshot() {
  return SemanticSnapshotV1Schema.parse({
    ...snapshot(),
    focusedRef: 'semantic_node_fixture_001',
    focusState: 'node',
    focusRevision: 1,
    rootRefs: ['semantic_node_fixture_001'],
    nodes: [
      {
        nodeRef: 'semantic_node_fixture_001',
        frameId: 'semantic_frame_fixture_01',
        frameNavigationGeneration: 0,
        parentRef: null,
        childRefs: [],
        role: 'textbox',
        name: 'Message',
        value: 'original page value',
        states: { focused: true },
        editKind: 'plainText',
        actions: ['insertText', 'replaceText', 'key'],
        redacted: false,
        truncated: false,
      },
    ],
  });
}
for (const order of [
  'receipt-first',
  'events-first',
  'unrelated-dirty',
  'missing-watermark',
] as const) {
  it(`adopts only the ordered exact own-edit watermark (${order}) without confirming page text`, async () => {
    vi.useFakeTimers();
    const value = plainSnapshot();
    let deliver:
      ((event: ReturnType<typeof SemanticEventV1Schema.parse> | null) => void) | undefined;
    let request: SemanticActionV1 | undefined;
    let release: ((value: ReturnType<typeof SemanticReceiptV1Schema.parse>) => void) | undefined;
    let rejectOriginal: ((value: unknown) => void) | undefined;
    const fixtureCancellation = new Error('ORIGINAL_EDIT_FIXTURE_CLEANUP');
    const operations: Promise<void>[] = [];
    const read = vi.fn(async () => value);
    const delivery: BrowserSemanticTransport = {
      readBrowserSemantic: read,
      openBrowserSemanticStream: async () => ({
        eventStreamId: 'semantic_stream_fixture_01',
        next: (signal) =>
          new Promise((resolve) => {
            deliver = resolve;
            signal.addEventListener('abort', () => resolve(null), { once: true });
          }),
        close: async () => {
          deliver?.(null);
        },
      }),
      actionBrowserSemantic: async (_scope, _controller, original) => {
        request = original;
        return new Promise((resolve, reject) => {
          release = resolve;
          rejectOriginal = reject;
        });
      },
    };
    const session = new SemanticOutlineSession(
      delivery,
      scope,
      () => 'controller_fixture_000001',
      new AbortController().signal
    );
    onTestFinished(async () => {
      // Fence queued original producers first, then settle any already-entered held response.
      const closing = session.close();
      void closing.catch(() => {});
      rejectOriginal?.(fixtureCancellation);
      try {
        await Promise.allSettled(operations);
        try {
          await closing;
        } catch (value) {
          if (!Object.is(value, fixtureCancellation)) throw value;
        }
      } finally {
        vi.useRealTimers();
      }
    });
    await session.read();
    const operation = session.act(value.nodes[0], { kind: 'insertText', text: 'new local draft' });
    operations.push(operation);
    void operation.catch(() => {});
    await vi.waitFor(() => expect(request).toBeDefined());
    const original = request!;
    const { semanticLeaseId: _lease, ...identity } = original.identity;
    const fresh = {
      ...identity,
      treeRevision: identity.treeRevision + 1,
      semanticLeaseId: 'semantic_lease_fixture_002',
    };
    const event = SemanticEventV1Schema.parse({
      version: 1,
      eventStreamId: original.eventStreamId,
      sequence: 1,
      identity: { ...identity, treeRevision: fresh.treeRevision },
      type: 'dirty',
      reason: 'domChanged',
      ...(order === 'unrelated-dirty' ? {} : { editRequestId: original.requestId }),
    });
    const receipt = SemanticReceiptV1Schema.parse({
      version: 1,
      requestId: original.requestId,
      identity,
      outcome: 'completed',
      editContinuation: {
        identity: fresh,
        frameId: original.frameId,
        frameNavigationGeneration: original.frameNavigationGeneration,
        nodeRef: 'semantic_node_fixture_002',
        focusRevision: original.focusRevision,
        expiresInMs: 1500,
        eventStreamId: original.eventStreamId,
        coveredEventSequence: order === 'missing-watermark' ? 2 : 1,
        allowedKinds: ['insertText', 'replaceText', 'key'],
      },
    });
    if (order === 'receipt-first') {
      release!(receipt);
      await Promise.resolve();
      await Promise.resolve();
      expect(session.snapshot().pending).toBe(true);
      deliver!(event);
    } else {
      deliver!(event);
      await Promise.resolve();
      await Promise.resolve();
      expect(session.snapshot().pending).toBe(order !== 'unrelated-dirty');
      if (order === 'unrelated-dirty') {
        expect(session.snapshot().stale).toBe(true);
        expect(session.snapshot().continuedRef).toBeUndefined();
      }
      release!(receipt);
    }
    if (order === 'missing-watermark') await vi.advanceTimersByTimeAsync(2000);
    if (order === 'unrelated-dirty' || order === 'missing-watermark') {
      await expect(operation).rejects.toThrow('SEMANTIC_TARGET_CHANGED');
      expect(session.snapshot().stale).toBe(true);
      expect(session.snapshot().continuedRef).toBeUndefined();
      return;
    }
    await operation;
    const adopted = session.snapshot();
    expect(adopted.stale).toBe(false);
    expect(adopted.continuedRef).toBe('semantic_node_fixture_002');
    expect(adopted.snapshot?.nodes).toHaveLength(1);
    expect(adopted.snapshot?.nodes[0].value).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
    if (order === 'receipt-first') {
      const following = session.act(adopted.snapshot!.nodes[0], {
        kind: 'insertText',
        text: 'explicit next commit',
      });
      operations.push(following);
      void following.catch(() => {});
      await vi.waitFor(() =>
        expect(request?.identity.semanticLeaseId).toBe('semantic_lease_fixture_002')
      );
      expect(request?.nodeRef).toBe('semantic_node_fixture_002');
      expect(read).toHaveBeenCalledTimes(2);
      const { semanticLeaseId: _nextLease, ...nextIdentity } = request!.identity;
      release!(
        SemanticReceiptV1Schema.parse({
          version: 1,
          requestId: request!.requestId,
          identity: nextIdentity,
          outcome: 'completed',
        })
      );
      await following;
      expect(session.snapshot().stale).toBe(true);
      return;
    }
    await vi.advanceTimersByTimeAsync(1500);
    expect(session.snapshot().stale).toBe(true);
    await expect(
      session.act(adopted.snapshot!.nodes[0], { kind: 'insertText', text: 'no replay' })
    ).rejects.toThrow('SEMANTIC_ACTION_REFUSED');
  });
}

it('a slow non-edit action retains the original lifetime signal past the edit budget', async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const plain = plainSnapshot();
  const { value: _value, ...plainNode } = plain.nodes[0]!;
  const node = {
    ...plainNode,
    editKind: 'none' as const,
    actions: ['activate' as const],
    role: 'button' as const,
  };
  const value = SemanticSnapshotV1Schema.parse({ ...plain, nodes: [node] });
  let originalLifetime: AbortSignal | undefined;
  let originalSignal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const session = new SemanticOutlineSession(
    {
      readBrowserSemantic: async (_scope, signal) => {
        originalLifetime = signal;
        return value;
      },
      openBrowserSemanticStream: async () => ({
        eventStreamId: 'semantic_stream_fixture_01',
        next: (signal) =>
          new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve(null), { once: true })
          ),
        close: async () => {},
      }),
      actionBrowserSemantic: async (_scope, _controller, request, signal) => {
        originalSignal = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        const { semanticLeaseId: _lease, ...identity } = request.identity;
        return { version: 1, requestId: request.requestId, identity, outcome: 'completed' };
      },
    },
    scope,
    () => 'controller_fixture_000001',
    new AbortController().signal
  );
  onTestFinished(async () => {
    release?.();
    await session.close();
    vi.useRealTimers();
  });
  await session.read();
  const original = session.act(node, { kind: 'activate' });
  await vi.waitFor(() => expect(originalSignal).toBeDefined());
  // Native AbortSignal.timeout is not driven by fake timers. Exact original
  // signal identity proves no edit-only timeout signal was introduced here.
  expect(originalSignal).toBe(originalLifetime);
  await vi.advanceTimersByTimeAsync(2100);
  expect(originalSignal!.aborted).toBe(false);
  release!();
  await original;
});

it('an admitted stale lease refusal clears refs but permits an explicit fresh read without replay', async () => {
  const value = plainSnapshot();
  const read = vi.fn(async () => value);
  const action = vi.fn<BrowserSemanticTransport['actionBrowserSemantic']>(
    async (_scope, _controller, request) => {
      const { semanticLeaseId: _lease, ...identity } = request.identity;
      return {
        version: 1,
        requestId: request.requestId,
        identity,
        outcome: 'rejected',
        reason: 'staleLease',
      };
    }
  );
  const session = new SemanticOutlineSession(
    {
      readBrowserSemantic: read,
      actionBrowserSemantic: action,
      openBrowserSemanticStream: async () => ({
        eventStreamId: 'semantic_stream_fixture_01',
        next: (signal) =>
          new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve(null), { once: true })
          ),
        close: async () => {},
      }),
    },
    scope,
    () => 'controller_fixture_000001',
    new AbortController().signal
  );
  onTestFinished(() => session.close());
  await session.read();
  await expect(
    session.act(value.nodes[0], { kind: 'insertText', text: 'not replayed' })
  ).rejects.toThrow('SEMANTIC_TARGET_CHANGED');
  expect(session.snapshot().stale).toBe(true);
  await session.read();
  expect(session.snapshot().stale).toBe(false);
  expect(action).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(3);
});
