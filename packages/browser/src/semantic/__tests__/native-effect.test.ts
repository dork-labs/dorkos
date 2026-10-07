import { expect, it, onTestFinished, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import type { CDPSession } from 'playwright-core';
import { semanticNativeEffect } from '../native-effect.js';
import { NativeSemanticTargetSchema } from '../native-target.js';
const target = NativeSemanticTargetSchema.parse({
  identity: {
    version: 1,
    browserId: 'browser_subject_A_000000000000000',
    browserGeneration: 0,
    tabId: 'canonical_tab_A_00000000000000000',
    navigationGeneration: 0,
    viewportVersion: 0,
    epoch: 0,
    inputGeneration: 0,
    treeId: 'semantic_tree_fixture_0001',
    treeRevision: 1,
    grantRevision: 1,
    semanticLeaseId: 'semantic_lease_fixture_001',
  },
  nodeRef: 'semantic_node_fixture_0001',
  frameId: 'semantic_frame_fixture_001',
  frameNavigationGeneration: 0,
  nativeFrameId: 'native-main',
  nativeTargetId: 'owned-target',
  backendNodeId: 2,
  documentBackendNodeId: 1,
  role: 'textbox',
  name: 'Field',
  kind: 'plainText',
  disabled: false,
  readonly: false,
  focused: true,
  focusRevision: 1,
});
// Named protocol doubles verify original admission and promise custody, not native allocation/Chromium behavior.
it('enters no original command when the original send getter revokes admission', async () => {
  let current = true;
  const send = vi.fn();
  const session = Object.defineProperty({}, 'send', {
    get() {
      current = false;
      return send;
    },
  }) as CDPSession;
  const denial = new Error('EXACT_ADMISSION_REFUSED');
  await expect(
    semanticNativeEffect(
      session,
      target,
      () => {
        if (!current) throw denial;
      },
      true
    )
  ).rejects.toBe(denial);
  expect(send).not.toHaveBeenCalled();
});
it('retains held original metadata and its falsy rejection without entering focus or unused group cleanup', async () => {
  const bank: {
    reject?: (value: unknown) => void;
    original?: Promise<unknown>;
  } = {};
  onTestFinished(async () => {
    bank.reject?.(undefined);
    if (bank.original)
      try {
        await bank.original;
      } catch (value) {
        if (value !== undefined) throw value;
      }
  });
  const held = new Promise<never>((_resolve, reject) => {
    bank.reject = reject;
  });
  const send = vi.fn(() => held);
  const session = { send } as unknown as CDPSession;
  let settled = false;
  const original = (bank.original = semanticNativeEffect(session, target, () => {}, true));
  void original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  for (let index = 0; index < 8; index++) await Promise.resolve();
  expect(settled).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('Target.getTargetInfo');
  bank.reject!(undefined);
  await expect(original).rejects.toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
});

function effectFixture(secret = false) {
  const calls: string[] = [];
  const document = {
    activeElement: undefined as object | undefined,
    hasFocus: () => true,
  };
  const valueReads = { count: 0 };
  const element = {
    ownerDocument: document,
    localName: 'input',
    type: secret ? 'password' : 'text',
    isConnected: true,
    disabled: false,
    readOnly: false,
    selectionStart: 0,
    selectionEnd: 5,
    get value() {
      valueReads.count++;
      if (secret) throw new Error('SECRET_VALUE_READ');
      return 'hello';
    },
  };
  const state = { role: 'textfield' };
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push(method);
    switch (method) {
      case 'Target.getTargetInfo':
        return { targetInfo: { type: 'page', targetId: 'owned-target' } };
      case 'Page.createIsolatedWorld':
        return { executionContextId: 1 };
      case 'DOM.resolveNode':
        return {
          object: {
            objectId: params.backendNodeId === 1 ? 'document' : 'element',
          },
        };
      case 'Runtime.callFunctionOn': {
        const original = runInNewContext('(' + params.functionDeclaration + ')', { document });
        return {
          result: { value: Reflect.apply(original, element, [document]) },
        };
      }
      case 'Accessibility.getPartialAXTree':
        return {
          nodes: [
            {
              backendDOMNodeId: 2,
              role: { value: state.role },
              name: { value: 'Field' },
            },
          ],
        };
      case 'DOM.focus':
        document.activeElement = element;
        return {};
      case 'Runtime.releaseObjectGroup':
        return {};
      default:
        throw new Error('UNEXPECTED_ORIGINAL_COMMAND');
    }
  });
  return {
    send,
    calls,
    state,
    valueReads,
    session: { send } as unknown as CDPSession,
  };
}

it('consumes full original focus/AX/inspection/release commands on an admitted target', async () => {
  const f = effectFixture();
  const result = await semanticNativeEffect(f.session, target, () => {}, true);
  expect(result).toEqual({
    connected: true,
    focused: true,
    disabled: false,
    readonly: false,
    kind: 'plainText',
    selectedAll: true,
  });
  expect(f.calls).toEqual([
    'Target.getTargetInfo',
    'Page.createIsolatedWorld',
    'DOM.resolveNode',
    'DOM.resolveNode',
    'Runtime.callFunctionOn',
    'Accessibility.getPartialAXTree',
    'DOM.focus',
    'Runtime.callFunctionOn',
    'Accessibility.getPartialAXTree',
    'Runtime.releaseObjectGroup',
  ]);
});

it('executes the actual fixed password inspector without accessing its throwing value getter', async () => {
  const f = effectFixture(true);
  const secretTarget = NativeSemanticTargetSchema.parse({
    ...target,
    kind: 'secret',
    name: '',
  });
  const result = await semanticNativeEffect(f.session, secretTarget, () => {}, true);
  expect(result.kind).toBe('secret');
  expect(result.focused).toBe(true);
  expect(result.selectedAll).toBe(false);
  expect(f.valueReads.count).toBe(0);
  expect(f.calls.at(-1)).toBe('Runtime.releaseObjectGroup');
  expect(Object.keys(result).sort()).toEqual([
    'connected',
    'disabled',
    'focused',
    'kind',
    'readonly',
    'selectedAll',
  ]);
});

it('refuses a fresh AX role mismatch before original focus and still releases its original group', async () => {
  const f = effectFixture();
  f.state.role = 'button';
  await expect(semanticNativeEffect(f.session, target, () => {}, true)).rejects.toThrow(
    'SEMANTIC_TARGET_REFUSED'
  );
  expect(f.calls).not.toContain('DOM.focus');
  expect(f.calls.at(-1)).toBe('Runtime.releaseObjectGroup');
});

it('joins held original focus and release and retains undefined ahead of the later false cleanup cause', async () => {
  const f = effectFixture(),
    originalSend = f.send.getMockImplementation()!;
  const bank: {
    reject?: (reason: unknown) => void;
    release?: () => void;
    operation?: Promise<unknown>;
  } = {};
  const release = () => {
    const original = bank.release;
    bank.release = undefined;
    original?.();
  };
  onTestFinished(async () => {
    bank.reject?.(undefined);
    release();
    if (bank.operation)
      await bank.operation.catch((reason) => {
        if (reason !== undefined) throw reason;
      });
  });
  const held = new Promise<never>((_resolve, reject) => {
    bank.reject = reject;
  });
  const closing = new Promise<void>((resolve) => {
    bank.release = resolve;
  });
  f.send.mockImplementation(async (method, params) => {
    if (method === 'DOM.focus') {
      f.calls.push(method);
      return held;
    }
    if (method === 'Runtime.releaseObjectGroup') {
      f.calls.push(method);
      await closing;
      throw false;
    }
    return originalSend(method, params);
  });
  bank.operation = semanticNativeEffect(f.session, target, () => {}, true);
  let returned = false;
  void bank.operation.then(
    () => {
      returned = true;
    },
    () => {
      returned = true;
    }
  );
  await vi.waitFor(() => expect(f.calls).toContain('DOM.focus'));
  expect(returned).toBe(false);
  bank.reject!(undefined);
  await vi.waitFor(() => expect(f.calls).toContain('Runtime.releaseObjectGroup'));
  expect(returned).toBe(false);
  release();
  await expect(bank.operation).rejects.toBeUndefined();
  expect(f.calls.filter((method) => method === 'Runtime.releaseObjectGroup')).toHaveLength(1);
});

it('uses the actual fixed effect chain on a retained iframe session only when its native target matches', async () => {
  const f = effectFixture(),
    original = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (method, params) =>
    method === 'Target.getTargetInfo'
      ? { targetInfo: { type: 'iframe', targetId: 'owned-target' } }
      : original(method, params)
  );
  const child = NativeSemanticTargetSchema.parse({
    ...target,
    nativeFrameSlot: 1,
  });
  await expect(semanticNativeEffect(f.session, child, () => {}, true)).resolves.toMatchObject({
    focused: true,
  });
  expect(f.calls).toContain('DOM.focus');
  expect(f.calls.at(-1)).toBe('Runtime.releaseObjectGroup');
});
