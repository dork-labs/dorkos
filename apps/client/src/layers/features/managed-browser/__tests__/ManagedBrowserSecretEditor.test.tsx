import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ManagedBrowserSecretEditor } from '../ui/ManagedBrowserSecretEditor';
afterEach(() => cleanup());
it('defaults to password and requires explicit target confirmation before any keyboard submission', async () => {
  const write = vi.fn(async () => {});
  render(
    <ManagedBrowserSecretEditor targetLabel="Password field" disabled={false} onWrite={write} />
  );
  const input = screen.getByLabelText('New secret') as HTMLInputElement;
  expect(input.type).toBe('password');
  fireEvent.change(input, { target: { value: 'local-only-secret' } });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  expect(write).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('I confirm this is the field I want to write to.'));
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  });
  expect(write).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith('local-only-secret');
  expect(input.value).toBe('');
  expect(input.type).toBe('password');
  expect(screen.queryByText('local-only-secret')).toBeNull();
});
it('Escape clears local text and confirmation without native or transport activity', () => {
  const write = vi.fn(async () => {});
  render(
    <ManagedBrowserSecretEditor targetLabel="Password field" disabled={false} onWrite={write} />
  );
  const input = screen.getByLabelText('New secret') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'secret' } });
  fireEvent.click(screen.getByLabelText('I confirm this is the field I want to write to.'));
  fireEvent.click(screen.getByLabelText('Show local text'));
  expect(input.type).toBe('text');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(input.value).toBe('');
  expect(input.type).toBe('password');
  expect(
    (screen.getByLabelText('I confirm this is the field I want to write to.') as HTMLInputElement)
      .checked
  ).toBe(false);
  expect(write).not.toHaveBeenCalled();
});
it('keeps a failed write opaque and never restores the submitted secret', async () => {
  const write = vi.fn(async () => {
    throw undefined;
  });
  render(
    <ManagedBrowserSecretEditor targetLabel="Password field" disabled={false} onWrite={write} />
  );
  const input = screen.getByLabelText('New secret') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'do-not-restore' } });
  fireEvent.click(screen.getByLabelText('I confirm this is the field I want to write to.'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Write secret' }));
  });
  expect(input.value).toBe('');
  expect(screen.getByRole('alert').textContent).not.toContain('do-not-restore');
  expect(write).toHaveBeenCalledOnce();
});

// Delivery doubles exercise real local editor/session lifetimes, not native readiness.
import { onTestFinished } from 'vitest';
import { SemanticSnapshotV1Schema } from '@dorkos/shared/browser-semantic-schemas';
import type { BrowserSemanticScope, BrowserSemanticTransport } from '@dorkos/shared/transport';
import { ManagedBrowserOutline } from '../ui/ManagedBrowserOutline';
const semanticScope: BrowserSemanticScope = {
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
function secretSnapshot(revision: number, changed = false) {
  const nodeRef = changed ? 'semantic_node_different_001' : 'semantic_node_password_001';
  return SemanticSnapshotV1Schema.parse({
    version: 1,
    ...semanticScope.binding,
    treeId: 'semantic_tree_fixture_0001',
    treeRevision: revision,
    grantRevision: 1,
    semanticLeaseId: `semantic_lease_fixture_00${revision}`,
    capturedAt: new Date().toISOString(),
    expiresInMs: 2000,
    rootRefs: [nodeRef],
    nodes: [
      {
        nodeRef,
        frameId: 'semantic_frame_fixture_001',
        frameNavigationGeneration: 0,
        parentRef: null,
        childRefs: [],
        role: 'textbox',
        name: 'Password field',
        states: { focused: true },
        editKind: 'secret',
        actions: ['writeSecret'],
        redacted: true,
        truncated: false,
      },
    ],
    focusedRef: nodeRef,
    focusState: 'node',
    focusRevision: 1,
    completeness: 'complete',
  });
}
for (const changed of [false, true]) {
  it(`retains local text after two-second expiry and ${changed ? 'refuses a changed native target' : 'freshly confirms the same native target before submission'}`, async () => {
    vi.useFakeTimers();
    const loss = new AbortController();
    onTestFinished(async () => {
      loss.abort();
      await vi.runOnlyPendingTimersAsync();
      cleanup();
      vi.useRealTimers();
    });
    let revision = 0,
      streams = 0;
    const read = vi.fn<BrowserSemanticTransport['readBrowserSemantic']>(async () =>
      secretSnapshot(++revision, changed && revision > 1)
    );
    const mutation = vi.fn<BrowserSemanticTransport['actionBrowserSemantic']>(
      async (_scope, _controller, request) => {
        const { semanticLeaseId: _lease, ...identity } = request.identity;
        return {
          version: 1,
          requestId: request.requestId,
          identity,
          outcome: 'completed',
        };
      }
    );
    const delivery: BrowserSemanticTransport = {
      readBrowserSemantic: read,
      actionBrowserSemantic: mutation,
      openBrowserSemanticStream: async (_scope, _lease, signal) => {
        const ordinal = ++streams,
          eventStreamId = `semantic_stream_fixture_00${ordinal}`;
        let delivered = false;
        return {
          eventStreamId,
          next: async () => {
            if (ordinal === 1 && !delivered) {
              delivered = true;
              await new Promise<void>((resolve) => setTimeout(resolve, 2001));
              const {
                semanticLeaseId: _lease,
                capturedAt: _at,
                expiresInMs: _expiry,
                rootRefs: _roots,
                nodes: _nodes,
                focusedRef: _ref,
                focusState: _state,
                focusRevision: _focus,
                completeness: _complete,
                ...identity
              } = secretSnapshot(1);
              return {
                version: 1,
                eventStreamId,
                sequence: 1,
                identity,
                type: 'reset',
                reason: 'leaseExpired',
              };
            }
            return new Promise<null>((_resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
            });
          },
          close: async () => {},
        };
      },
    };
    render(
      <ManagedBrowserOutline
        delivery={delivery}
        scope={semanticScope}
        readController={() => 'controller_fixture_000001'}
        lossSignal={loss.signal}
        secretAllowed
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read page' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Write secret' }));
    const input = screen.getByLabelText('New secret') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'local-only-value' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2251);
    });
    expect(screen.getByLabelText('New secret')).toBe(input);
    expect(input.value).toBe('local-only-value');
    expect(read).toHaveBeenCalledTimes(1);
    expect(mutation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('I confirm this is the field I want to write to.'));
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(mutation).toHaveBeenCalledTimes(changed ? 0 : 1);
    expect(input.value).toBe('');
    if (!changed)
      expect(mutation.mock.calls[0][2].identity.semanticLeaseId).toBe('semantic_lease_fixture_002');
    loss.abort();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(screen.queryByLabelText('New secret')).toBeNull();
  });
}

// Synthetic events qualify local editor lifetime behavior only, never native IME.
it('does not submit unfinished composition from the shortcut, form, or explicit button', async () => {
  const write = vi.fn(async () => {});
  render(
    <ManagedBrowserSecretEditor targetLabel="Password field" disabled={false} onWrite={write} />
  );
  const input = screen.getByLabelText('New secret') as HTMLInputElement;
  fireEvent.click(screen.getByLabelText('I confirm this is the field I want to write to.'));
  fireEvent.compositionStart(input);
  fireEvent.change(input, {
    target: { value: 'unfinished-local-composition' },
  });
  await act(async () => {
    fireEvent.keyDown(input, {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Write secret to selected field' }));
    fireEvent.click(screen.getByRole('button', { name: 'Write secret' }));
  });
  expect(write).not.toHaveBeenCalled();
  expect(input.value).toBe('unfinished-local-composition');
  fireEvent.compositionEnd(input);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Write secret' }));
  });
  expect(write).toHaveBeenCalledExactlyOnceWith('unfinished-local-composition');
});
it('a controller-lifetime remount clears the original composing editor and cannot submit its late completion', async () => {
  const write = vi.fn(async () => {});
  const view = render(
    <ManagedBrowserSecretEditor
      key="original-epoch"
      targetLabel="Password field"
      disabled={false}
      onWrite={write}
    />
  );
  const original = screen.getByLabelText('New secret') as HTMLInputElement;
  fireEvent.click(screen.getByLabelText('I confirm this is the field I want to write to.'));
  fireEvent.compositionStart(original);
  fireEvent.change(original, {
    target: { value: 'old-epoch-local-composition' },
  });
  view.rerender(
    <ManagedBrowserSecretEditor
      key="new-epoch"
      targetLabel="Password field"
      disabled={false}
      onWrite={write}
    />
  );
  expect(original.value).toBe('');
  const current = screen.getByLabelText('New secret') as HTMLInputElement;
  expect(current).not.toBe(original);
  expect(current.value).toBe('');
  await act(async () => {
    fireEvent.compositionEnd(original);
    fireEvent.keyDown(original, { key: 'Enter', ctrlKey: true });
  });
  expect(write).not.toHaveBeenCalled();
});
