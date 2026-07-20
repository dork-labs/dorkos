// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { useAgentCreationStore } from '@/layers/shared/model';
import { useMarketplaceStore } from '../model/marketplace-store';
import { useRequestInstall } from '../model/use-request-install';
import { agentPackageToCreationSeed } from '../model/agent-package-seed';

function pkg(overrides: Partial<AggregatedPackage> = {}): AggregatedPackage {
  return {
    name: '@dorkos/code-reviewer',
    source: 'github:dorkos/marketplace/plugins/code-reviewer',
    description: 'Reviews pull requests every weekday.',
    type: 'agent',
    marketplace: 'dork-labs',
    ...overrides,
  };
}

describe('agentPackageToCreationSeed', () => {
  it('maps a package to a marketplace-agent seed with source, persona, and icon', () => {
    const seed = agentPackageToCreationSeed(pkg({ displayName: 'Code Reviewer', icon: '🔍' }));
    expect(seed.origin).toBe('marketplace-agent');
    expect(seed.sourceLabel).toBe('dork-labs');
    expect(seed.template.source).toBe('github:dorkos/marketplace/plugins/code-reviewer');
    expect(seed.template.displayName).toBe('Code Reviewer');
    expect(seed.template.persona).toBe('Reviews pull requests every weekday.');
    expect(seed.template.icon).toBe('🔍');
  });

  it('humanizes the slug when the package ships no displayName', () => {
    const seed = agentPackageToCreationSeed(pkg({ displayName: undefined }));
    expect(seed.template.displayName).toBe('Code Reviewer');
  });
});

describe('useRequestInstall', () => {
  beforeEach(() => {
    useMarketplaceStore.setState({ installConfirmPackage: null, installContext: null });
    useAgentCreationStore.setState({ isOpen: false, seed: null, onCreated: null });
  });

  it('routes an agent package into the creation seed flow, never the confirm dialog', () => {
    const { result } = renderHook(() => useRequestInstall());
    result.current(pkg({ type: 'agent' }));

    expect(useMarketplaceStore.getState().installConfirmPackage).toBeNull();
    const seed = useAgentCreationStore.getState().seed;
    expect(useAgentCreationStore.getState().isOpen).toBe(true);
    expect(seed?.origin).toBe('marketplace-agent');
    expect(seed?.template.source).toBe('github:dorkos/marketplace/plugins/code-reviewer');
  });

  it('opens the confirm dialog for a non-agent package', () => {
    const { result } = renderHook(() => useRequestInstall());
    const plugin = pkg({ name: '@dorkos/pr-linter', type: 'plugin' });
    result.current(plugin);

    expect(useMarketplaceStore.getState().installConfirmPackage?.name).toBe('@dorkos/pr-linter');
    expect(useAgentCreationStore.getState().isOpen).toBe(false);
  });

  it('ignores an agent-scope context for agent packages (identity replacement is impossible)', () => {
    const { result } = renderHook(() => useRequestInstall());
    result.current(pkg({ type: 'agent' }), {
      agentPath: '/home/test/.dork/agents/existing',
      agentName: 'Existing',
    });

    // No confirm dialog, no projectPath-scoped install — a fresh creation instead.
    expect(useMarketplaceStore.getState().installConfirmPackage).toBeNull();
    expect(useMarketplaceStore.getState().installContext).toBeNull();
    expect(useAgentCreationStore.getState().isOpen).toBe(true);
  });
});
