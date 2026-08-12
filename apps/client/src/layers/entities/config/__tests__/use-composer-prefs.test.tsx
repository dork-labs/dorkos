/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import type { ComposerPrefs } from '@dorkos/shared/config-schema';
import { COMPOSER_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useComposerRichText, useUpdateComposerPrefs } from '../model/use-composer-prefs';

function makeServerConfig(composer: ComposerPrefs): ServerConfig {
  return { ui: { composer } } as unknown as ServerConfig;
}

function createHarness(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe('useComposerRichText', () => {
  it('reads the shipped default while config has not loaded', () => {
    // The rule, asserted as a rule: the loading answer IS the shipped default,
    // so the person who never touched the switch never sees the field swap.
    // Asserting `COMPOSER_PREFS_DEFAULTS.richText` rather than a literal is what
    // makes this survive the next change of default instead of pinning today's.
    const transport = createMockTransport({ getConfig: vi.fn().mockResolvedValue({}) });
    const { wrapper } = createHarness(transport);
    const { result } = renderHook(() => useComposerRichText(), { wrapper });
    expect(result.current).toBe(COMPOSER_PREFS_DEFAULTS.richText);
  });

  it('ships with formatting as you type ON (owner decision, 2026-08-12)', () => {
    // Separate from the test above on purpose. That one says the hook agrees
    // with the default; this one says what the default IS, so flipping it is a
    // deliberate edit here rather than a silent pass.
    expect(COMPOSER_PREFS_DEFAULTS.richText).toBe(true);
  });

  it('reads the stored value once config resolves', () => {
    const transport = createMockTransport({ getConfig: vi.fn().mockResolvedValue({}) });
    const { queryClient, wrapper } = createHarness(transport);
    // Stored `false` rather than `true`: it is the value that DISAGREES with the
    // default, so it is the only one that can fail if the hook ever stops
    // reading config and starts answering from the default alone.
    queryClient.setQueryData(configKeys.current(), makeServerConfig({ richText: false }));
    const { result } = renderHook(() => useComposerRichText(), { wrapper });
    expect(result.current).toBe(false);
  });

  it('falls back to the default for a ui block that predates the section', () => {
    const transport = createMockTransport({ getConfig: vi.fn().mockResolvedValue({}) });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), { ui: {} } as unknown as ServerConfig);
    const { result } = renderHook(() => useComposerRichText(), { wrapper });
    expect(result.current).toBe(COMPOSER_PREFS_DEFAULTS.richText);
  });
});

describe('useUpdateComposerPrefs', () => {
  it('setRichText(true) sends exactly the composer subtree and nothing else', async () => {
    const transport = createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
    const { queryClient, wrapper } = createHarness(transport);
    // `statusBar` stands in for "the rest of `ui`": the wire projection carries
    // no `theme`, so a sibling that really is on it is the honest control.
    queryClient.setQueryData(configKeys.current(), {
      ui: { statusBar: { pins: ['git'] }, composer: { richText: false } },
    } as unknown as ServerConfig);

    const { result } = renderHook(() => useUpdateComposerPrefs(), { wrapper });

    act(() => {
      result.current.setRichText(true);
    });

    // Optimistic cache write (onMutate), with the rest of `ui` intact.
    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.composer.richText
      ).toBe(true)
    );
    expect(
      queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.statusBar.pins
    ).toEqual(['git']);

    // `PATCH /api/config` deep-merges plain objects, so a composer-only patch
    // leaves every other `ui` key alone.
    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(1));
    expect(transport.updateConfig).toHaveBeenCalledWith({ ui: { composer: { richText: true } } });
  });

  it('setRichText(false) turns it back off in one write', async () => {
    const transport = createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), makeServerConfig({ richText: true }));

    const { result } = renderHook(() => useUpdateComposerPrefs(), { wrapper });

    act(() => {
      result.current.setRichText(false);
    });

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ ui: { composer: { richText: false } } })
    );
    // The literal, not `COMPOSER_PREFS_DEFAULTS`: this asserts the optimistic
    // write turned it OFF, and since the default is now `true` the two are no
    // longer the same claim.
    await waitFor(() =>
      expect(queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.composer).toEqual({
        richText: false,
      })
    );
  });

  it('leaves the cache alone when `ui` is absent rather than fabricating a partial one', async () => {
    const transport = createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), {} as unknown as ServerConfig);

    const { result } = renderHook(() => useUpdateComposerPrefs(), { wrapper });

    await act(async () => {
      result.current.setRichText(true);
    });

    // `onMutate` awaits `cancelQueries` before it writes, so the optimistic
    // write has NOT happened yet when `mutate` returns. Wait for the request to
    // go out — that is downstream of `onMutate` — or this assertion passes
    // because nothing has run, which is how a vacuous version of this test
    // survived its first mutation check.
    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(1));

    // The settle-time invalidate refetches; a half-built `ui` would be a lie.
    expect(queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui).toBeUndefined();
  });

  it('rolls back to the snapshot when the transport write fails', async () => {
    let rejectWrite!: (err: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const transport = createMockTransport({ updateConfig: vi.fn().mockReturnValue(pending) });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), makeServerConfig({ richText: false }));

    const { result } = renderHook(() => useUpdateComposerPrefs(), { wrapper });

    act(() => {
      result.current.setRichText(true);
    });

    // Optimistic state is applied while the write is in flight.
    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.composer.richText
      ).toBe(true)
    );

    await act(async () => {
      rejectWrite(new Error('boom'));
      await pending.catch(() => {});
    });

    // Rolled back to the pre-mutation snapshot.
    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.composer.richText
      ).toBe(false)
    );
  });
});
