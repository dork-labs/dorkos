// @vitest-environment jsdom
/**
 * The `?seed=dorkbot-help` launch link, at the seam that decides whether Ask
 * DorkBot's background reaches a turn (BC-48).
 *
 * Three properties are the whole feature: the background rides the FIRST send
 * and no other, the link is spent the moment it is taken, and nothing is ever
 * typed on somebody's behalf — the composer the person lands in is theirs and
 * stays empty.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import '@testing-library/jest-dom/vitest';

let mockAgents: { id: string; name: string; projectPath: string }[] = [];
vi.mock('@/layers/entities/mesh/model/use-mesh-agent-paths', () => ({
  useMeshAgentPaths: () => ({ data: { agents: mockAgents } }),
}));

let mockConfigData: Record<string, unknown> | undefined;
vi.mock('@/layers/entities/config/model/use-config', () => ({
  useConfig: () => ({ data: mockConfigData }),
}));

import type { SessionStatus } from '@dorkos/shared/session-stream';
import { setAskDorkBotOrigin, takeAskDorkBotOrigin } from '@/layers/shared/lib';
import { useSessionListStore } from '@/layers/entities/session';
import { useDorkBotSeed, __resetDorkBotSeedsForTest } from '../model/launch/use-dorkbot-seed';
import { useLaunchPrompt, __resetLaunchPromptsForTest } from '../model/launch/use-launch-prompt';

/** A fleet-stream status projection that settled into an error. */
function erroredStatus(): SessionStatus {
  return {
    contextUsage: null,
    cost: null,
    usage: null,
    cacheStats: null,
    model: null,
    permissionMode: 'default',
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle: 'error',
    lastError: null,
  };
}

interface Harness {
  sessionId?: string | null;
  seed?: string;
  messageCount?: number;
  hydrated?: boolean;
}

function setup(overrides: Harness = {}) {
  const onConsumed = vi.fn();
  const view = renderHook(
    (params: Harness) =>
      useDorkBotSeed({
        sessionId: params.sessionId ?? 'sess-1',
        seed: params.seed,
        messageCount: params.messageCount ?? 0,
        hydrated: params.hydrated ?? true,
        onConsumed,
      }),
    { initialProps: { seed: 'dorkbot-help', ...overrides } }
  );
  return { ...view, onConsumed };
}

beforeEach(() => {
  __resetDorkBotSeedsForTest();
  __resetLaunchPromptsForTest();
  takeAskDorkBotOrigin();
  mockAgents = [
    { id: 'a1', name: 'dorkbot', projectPath: '/dorkbot' },
    { id: 'a2', name: 'tangerine', projectPath: '/projects/tangerine' },
  ];
  mockConfigData = { version: '0.58.0', latestVersion: null };
  useSessionListStore.setState({
    sessions: {},
    statuses: {},
    statusCwds: {},
    unseen: {},
    rekeys: {},
  });
});

afterEach(() => {
  cleanup();
});

describe('useDorkBotSeed', () => {
  it('answers on the first send with the page, the fleet and the version', () => {
    setAskDorkBotOrigin('/marketplace');
    const { result } = setup();

    const seed = result.current();
    expect(seed).toBeDefined();
    expect(seed).toContain('/marketplace');
    expect(seed).toContain('2 agents registered');
    expect(seed).toContain('v0.58.0');
  });

  it('answers once and never again', () => {
    setAskDorkBotOrigin('/team');
    const { result, onConsumed } = setup();

    // Observable: there IS something to withhold on the second call.
    expect(result.current()).toBeDefined();
    expect(result.current()).toBeUndefined();
    expect(result.current()).toBeUndefined();
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it('survives a remount without re-arming', () => {
    setAskDorkBotOrigin('/team');
    const first = setup();
    expect(first.result.current()).toBeDefined();
    first.unmount();

    const second = setup();
    expect(second.result.current()).toBeUndefined();
  });

  it('does nothing at all without the seed param', () => {
    setAskDorkBotOrigin('/team');
    const { result, onConsumed } = setup({ seed: undefined });

    expect(result.current()).toBeUndefined();
    expect(onConsumed).not.toHaveBeenCalled();
    // Observable: the identical harness WITH the param both answers and
    // consumes, so the two negatives above are about the param and not about a
    // callback that can never fire.
    cleanup();
    __resetDorkBotSeedsForTest();
    const armed = setup();
    expect(armed.result.current()).toBeDefined();
    expect(armed.onConsumed).toHaveBeenCalledTimes(1);
  });

  it('ignores a seed value nothing enumerated', () => {
    const { result } = setup({ seed: 'delete-everything' });

    expect(result.current()).toBeUndefined();
  });

  it('spends a seed aimed at a conversation that already has history', () => {
    const { result, onConsumed } = setup({ messageCount: 4 });

    // Decided, not deferred: the URL is dropped so the link cannot ride forward
    // onto the next session that happens to look empty.
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(result.current()).toBeUndefined();
  });

  it('decides nothing before the conversation has hydrated', () => {
    const { result, onConsumed, rerender } = setup({ messageCount: 4, hydrated: false });

    expect(onConsumed).not.toHaveBeenCalled();
    // Observable: the same state DOES get spent the moment the snapshot lands.
    rerender({ seed: 'dorkbot-help', messageCount: 4, hydrated: true });
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(result.current()).toBeUndefined();
  });

  it('opens unseeded rather than inventing facts it does not have', () => {
    mockAgents = [];
    mockConfigData = undefined;
    const { result } = setup();

    const seed = result.current();
    expect(seed).toBeDefined();
    expect(seed).not.toContain('undefined');
    expect(seed).not.toContain('null');
    expect(seed).not.toMatch(/running DorkOS/);
  });

  it('reports the conversations that just failed', () => {
    useSessionListStore.setState({
      statuses: { 'sess-9': erroredStatus() },
    });
    const { result } = setup();

    expect(result.current()).toContain('sess-9');
  });
});

// ---------------------------------------------------------------------------
// The composer. Ask DorkBot types nothing.
// ---------------------------------------------------------------------------

/**
 * A composer both launch hooks can write to, so "the seed did not type" is read
 * off the same instrument that proves a prompt DOES.
 */
function ComposerHarness({ prompt, seed }: { prompt?: string; seed?: string }) {
  const [input, setInput] = useState('');
  useLaunchPrompt({
    sessionId: 'sess-1',
    prompt,
    autoSend: false,
    input,
    setInput,
    messageCount: 0,
    hydrated: true,
    status: 'idle',
    submit: vi.fn(),
  });
  useDorkBotSeed({ sessionId: 'sess-1', seed, messageCount: 0, hydrated: true });
  return <textarea data-testid="composer" readOnly value={input} />;
}

describe('the composer Ask DorkBot lands you in', () => {
  it('stays empty, while a ?prompt= link fills the same box', () => {
    render(<ComposerHarness prompt="summarize the release notes" />);
    // Observable: this harness CAN show a filled composer.
    expect(screen.getByTestId('composer')).toHaveValue('summarize the release notes');

    cleanup();
    __resetLaunchPromptsForTest();
    __resetDorkBotSeedsForTest();

    render(<ComposerHarness seed="dorkbot-help" />);
    expect(screen.getByTestId('composer')).toHaveValue('');
  });
});
