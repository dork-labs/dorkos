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

const MARKETPLACE_SEED: CreationSeed = {
  template: {
    displayName: 'Code Reviewer',
    source: 'github:dork-labs/marketplace/plugins/code-reviewer',
    persona: 'Reviews pull requests every weekday.',
    icon: '🔍',
  },
  origin: 'marketplace-agent',
  sourceLabel: 'dork-labs',
};

describe('useAgentCreationStore', () => {
  beforeEach(() => {
    useAgentCreationStore.setState({
      isOpen: false,
      initialMode: 'new',
      seed: null,
      onCreated: null,
    });
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

  it('openWithSeed() carries a marketplace-agent template source', () => {
    useAgentCreationStore.getState().openWithSeed(MARKETPLACE_SEED);
    const state = useAgentCreationStore.getState();
    expect(state.seed?.origin).toBe('marketplace-agent');
    expect(state.seed?.template.source).toBe('github:dork-labs/marketplace/plugins/code-reviewer');
  });

  it('open() stores a one-shot onCreated hook that close() clears', () => {
    const onCreated = () => {};
    useAgentCreationStore.getState().open('new', { onCreated });
    expect(useAgentCreationStore.getState().onCreated).toBe(onCreated);

    useAgentCreationStore.getState().close();
    expect(useAgentCreationStore.getState().onCreated).toBeNull();
  });
});
