// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { DORKBOT_ONBOARDING_LINES } from '@dorkos/shared/dorkbot-templates';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import {
  useOnboardingConversation,
  type OnboardingConversationPorts,
} from '../model/use-onboarding-conversation';
import { voiceSampleFor } from '../model/onboarding-script';

const TRAITS: Traits = {
  verbosity: 3,
  autonomy: 3,
  chaos: 3,
  creativity: 3,
  humor: 3,
  spice: 3,
};

function makePorts(
  overrides: Partial<OnboardingConversationPorts> = {}
): OnboardingConversationPorts {
  return {
    reducedMotion: true,
    saveTraits: vi.fn().mockResolvedValue(undefined),
    completeStep: vi.fn(),
    skipStep: vi.fn(),
    completeOnboarding: vi.fn(),
    onDissolve: vi.fn(),
    ...overrides,
  };
}

function contents(messages: { content: string }[]): string[] {
  return messages.map((m) => m.content);
}

describe('useOnboardingConversation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts in first light and reveals the arrival + personality beats on begin', async () => {
    const { result } = renderHook(() => useOnboardingConversation(makePorts()));
    expect(result.current.isFirstLight).toBe(true);

    act(() => result.current.beginConversation());

    await waitFor(() => expect(result.current.activeWidget).toBe('personality'));
    expect(result.current.isFirstLight).toBe(false);
    expect(contents(result.current.messages)).toEqual([
      DORKBOT_ONBOARDING_LINES.arrival[0],
      DORKBOT_ONBOARDING_LINES.arrival[1],
      DORKBOT_ONBOARDING_LINES.personalityPrompt,
    ]);
    expect(result.current.composerEnabled).toBe(false);
  });

  it('swaps the voice-sample bubble in place as personality changes', async () => {
    const { result } = renderHook(() => useOnboardingConversation(makePorts()));
    act(() => result.current.beginConversation());
    await waitFor(() => expect(result.current.activeWidget).toBe('personality'));

    const balanced = voiceSampleFor(TRAITS);
    const spicy = voiceSampleFor({ ...TRAITS, spice: 5 });

    act(() => result.current.selectPersonality(TRAITS));
    await waitFor(() =>
      expect(result.current.messages.some((m) => m.content === balanced)).toBe(true)
    );

    act(() => result.current.selectPersonality({ ...TRAITS, spice: 5 }));
    await waitFor(() =>
      expect(result.current.messages.some((m) => m.content === spicy)).toBe(true)
    );
    // The previous sample was replaced, not appended.
    expect(result.current.messages.filter((m) => m.content === balanced)).toHaveLength(0);
  });

  it('confirming personality saves traits, completes the step, and advances to discovery', async () => {
    const ports = makePorts();
    const { result } = renderHook(() => useOnboardingConversation(ports));
    act(() => result.current.beginConversation());
    await waitFor(() => expect(result.current.activeWidget).toBe('personality'));

    act(() => result.current.confirmPersonality({ ...TRAITS, humor: 5 }));

    await waitFor(() => expect(result.current.activeWidget).toBe('discovery'));
    expect(ports.saveTraits).toHaveBeenCalledWith({ ...TRAITS, humor: 5 });
    expect(ports.completeStep).toHaveBeenCalledWith('meet-dorkbot');
    expect(result.current.discoveryPhase).toBe('unasked');
    expect(contents(result.current.messages)).toContain(DORKBOT_ONBOARDING_LINES.discoveryPrompt);
  });

  it('surfaces a save error and does not advance when saving fails', async () => {
    const ports = makePorts({ saveTraits: vi.fn().mockRejectedValue(new Error('nope')) });
    const { result } = renderHook(() => useOnboardingConversation(ports));
    act(() => result.current.beginConversation());
    await waitFor(() => expect(result.current.activeWidget).toBe('personality'));

    act(() => result.current.confirmPersonality(TRAITS));

    await waitFor(() => expect(result.current.saveError).toBe(true));
    expect(result.current.activeWidget).toBe('personality');
    expect(ports.completeStep).not.toHaveBeenCalled();
  });

  it('consent moves discovery to scanning; decline skips the step and reaches handoff', async () => {
    const ports = makePorts();
    const { result } = renderHook(() => useOnboardingConversation(ports));
    act(() => result.current.beginConversation());
    await waitFor(() => expect(result.current.activeWidget).toBe('personality'));
    act(() => result.current.confirmPersonality(TRAITS));
    await waitFor(() => expect(result.current.activeWidget).toBe('discovery'));

    act(() => result.current.consentDiscovery());
    expect(result.current.discoveryPhase).toBe('scanning');
  });

  it('decline skips discovery and reaches the handoff (composer enabled, completeOnboarding fired)', async () => {
    const ports = makePorts();
    const { result } = renderHook(() => useOnboardingConversation(ports));
    act(() => result.current.beginConversation());
    await waitFor(() => expect(result.current.activeWidget).toBe('personality'));
    act(() => result.current.confirmPersonality(TRAITS));
    await waitFor(() => expect(result.current.activeWidget).toBe('discovery'));

    act(() => result.current.declineDiscovery());

    await waitFor(() => expect(result.current.composerEnabled).toBe(true));
    expect(ports.skipStep).toHaveBeenCalledWith('discovery');
    expect(ports.completeOnboarding).toHaveBeenCalledTimes(1);
    expect(result.current.beatId).toBe('handoff');
    expect(contents(result.current.messages)).toContain(DORKBOT_ONBOARDING_LINES.discoveryDecline);
    expect(contents(result.current.messages)).toContain(DORKBOT_ONBOARDING_LINES.handoffPrompt);
  });

  it('results -> Done completes discovery; zero and timeout report honestly', async () => {
    const ports = makePorts();
    const { result } = renderHook(() => useOnboardingConversation(ports));
    act(() => result.current.beginConversation());
    await waitFor(() => expect(result.current.activeWidget).toBe('personality'));
    act(() => result.current.confirmPersonality(TRAITS));
    await waitFor(() => expect(result.current.activeWidget).toBe('discovery'));

    act(() => result.current.reportDiscoveryResults(3));
    await waitFor(() => expect(result.current.discoveryPhase).toBe('results'));
    expect(contents(result.current.messages).some((c) => c.includes('Found 3'))).toBe(true);

    act(() => result.current.finishDiscovery());
    await waitFor(() => expect(result.current.beatId).toBe('handoff'));
    expect(ports.completeStep).toHaveBeenCalledWith('discovery');
  });

  it('reports the honest zero and timeout lines', async () => {
    const zeroPorts = makePorts();
    const zero = renderHook(() => useOnboardingConversation(zeroPorts));
    act(() => zero.result.current.beginConversation());
    await waitFor(() => expect(zero.result.current.activeWidget).toBe('personality'));
    act(() => zero.result.current.confirmPersonality(TRAITS));
    await waitFor(() => expect(zero.result.current.activeWidget).toBe('discovery'));
    act(() => zero.result.current.reportDiscoveryZero());
    await waitFor(() => expect(zero.result.current.beatId).toBe('handoff'));
    expect(contents(zero.result.current.messages)).toContain(
      DORKBOT_ONBOARDING_LINES.discoveryZero
    );
    expect(zeroPorts.completeStep).toHaveBeenCalledWith('discovery');

    const toPorts = makePorts();
    const to = renderHook(() => useOnboardingConversation(toPorts));
    act(() => to.result.current.beginConversation());
    await waitFor(() => expect(to.result.current.activeWidget).toBe('personality'));
    act(() => to.result.current.confirmPersonality(TRAITS));
    await waitFor(() => expect(to.result.current.activeWidget).toBe('discovery'));
    act(() => to.result.current.reportDiscoveryTimeout());
    await waitFor(() => expect(to.result.current.beatId).toBe('handoff'));
    expect(contents(to.result.current.messages)).toContain(
      DORKBOT_ONBOARDING_LINES.discoveryTimeout
    );
    expect(toPorts.skipStep).toHaveBeenCalledWith('discovery');
  });

  it('submitFirstMessage dissolves with the user text', async () => {
    const ports = makePorts();
    const { result } = renderHook(() => useOnboardingConversation(ports));
    act(() => result.current.submitFirstMessage('help me set up a project'));
    expect(ports.onDissolve).toHaveBeenCalledWith('help me set up a project');
  });

  it('fast-forward reveals every queued line at once (no reduced motion)', async () => {
    const { result } = renderHook(() =>
      useOnboardingConversation(makePorts({ reducedMotion: false }))
    );
    act(() => result.current.beginConversation());
    // Without reduced motion the reveal is staged; fast-forward drains it instantly.
    act(() => result.current.fastForward());
    await waitFor(() =>
      expect(contents(result.current.messages)).toContain(DORKBOT_ONBOARDING_LINES.arrival[1])
    );
  });
});
