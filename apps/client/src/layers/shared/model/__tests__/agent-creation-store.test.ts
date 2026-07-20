import { describe, it, expect, beforeEach } from 'vitest';
import { useAgentCreationStore, type CreationSeed } from '../agent-creation-store';

const SEED: CreationSeed = {
  template: {
    displayName: 'Linear Keeper',
    runtime: 'codex',
    persona: 'I keep your Linear board tidy.',
    capabilities: ['linear'],
    skills: ['linear-adapter'],
  },
  origin: 'shape-offer',
  sourceLabel: 'Linear Ops',
};

describe('useAgentCreationStore', () => {
  beforeEach(() => {
    useAgentCreationStore.setState({ isOpen: false, initialMode: 'new', seed: null });
  });

  it('open() opens the fork with no seed', () => {
    useAgentCreationStore.getState().open('template');
    const state = useAgentCreationStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.initialMode).toBe('template');
    expect(state.seed).toBeNull();
  });

  it('openWithSeed() opens seeded and preserves the full template', () => {
    useAgentCreationStore.getState().openWithSeed(SEED);
    const state = useAgentCreationStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.seed).toEqual(SEED);
  });

  it('open() after openWithSeed() drops the seed (the fork wins)', () => {
    useAgentCreationStore.getState().openWithSeed(SEED);
    useAgentCreationStore.getState().open();
    expect(useAgentCreationStore.getState().seed).toBeNull();
  });

  it('close() clears both the seed and the open flag', () => {
    useAgentCreationStore.getState().openWithSeed(SEED);
    useAgentCreationStore.getState().close();
    const state = useAgentCreationStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.seed).toBeNull();
    expect(state.initialMode).toBe('new');
  });
});
