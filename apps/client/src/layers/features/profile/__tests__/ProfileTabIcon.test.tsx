// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const docked = vi.hoisted(() => ({ path: '/agents/dorkbot' as string | null }));
const manifest = vi.hoisted(() => ({
  data: { id: 'dorkbot', name: 'DorkBot', color: '#336699', icon: '🤖' } as unknown,
}));
vi.mock('../model/use-docked-agent', () => ({ useDockedAgentPath: () => docked.path }));
vi.mock('@/layers/entities/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/agent')>()),
  useCurrentAgent: () => manifest,
}));

import { ProfileTabIcon } from '../ui/ProfileTabIcon';

afterEach(() => {
  cleanup();
  docked.path = '/agents/dorkbot';
});

describe('ProfileTabIcon (FB-60)', () => {
  it('wears the avatar of the agent the panel is about', () => {
    render(<ProfileTabIcon className="size-3.5" />);
    expect(screen.getByTestId('profile-tab-avatar')).toBeInTheDocument();
  });

  it('falls back to the person glyph when no agent is docked', () => {
    docked.path = null;
    const { container } = render(<ProfileTabIcon className="size-3.5" />);
    expect(screen.queryByTestId('profile-tab-avatar')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
