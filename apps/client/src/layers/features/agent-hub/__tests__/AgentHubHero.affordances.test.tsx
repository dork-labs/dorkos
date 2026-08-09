/**
 * @vitest-environment jsdom
 *
 * The hero's two edit affordances, and the corner they no longer fight over.
 *
 * The avatar's bottom-right corner belongs to identity — it is where the Bot
 * mark says what this face IS. A hover pencil used to sit on top of that mark,
 * so pointing at the agent replaced its identity with a tool icon, and it
 * marked the wrong control besides: pressing the disc opens the appearance
 * picker, not the name field.
 *
 * The pencil moved next to the name it renames. This file is what stops it
 * moving back, and what stops it going back to being pointer-only.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { AgentHubProvider } from '../model/agent-hub-context';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

// The management menu is a dropdown over stores and dialogs the hero itself
// knows nothing about — stubbed so this file is about the hero's own controls.
vi.mock('../ui/AgentManagementMenu', () => ({
  AgentManagementMenu: () => <div data-testid="agent-management-menu" />,
}));

const { AgentHubHero } = await import('../ui/AgentHubHero');

const AGENT = {
  name: 'scout',
  displayName: 'Scout',
  color: '#6366f1',
  icon: '\u{1F50D}',
  traits: DEFAULT_TRAITS,
} as unknown as AgentManifest;

/** The hero, with the smallest context that lets it draw. */
function renderHero() {
  return render(
    <AgentHubProvider
      value={{
        agent: AGENT,
        projectPath: '/tmp/scout',
        onUpdate: vi.fn(),
        onPersonalityUpdate: vi.fn(),
        previewColor: null,
        onPreviewColor: vi.fn(),
        isPickerOpen: false,
      }}
    >
      <AgentHubHero />
    </AgentHubProvider>
  );
}

afterEach(cleanup);

describe('AgentHubHero edit affordances', () => {
  it('names the rename control by its action, not by the agent', () => {
    // The button's only text is the agent's name, so without this a screen
    // reader announces "Scout, button" — which says who, never what pressing
    // it does.
    renderHero();

    expect(screen.getByRole('button', { name: 'Rename Scout' })).toBeInTheDocument();
  });

  it('shows the rename pencil to a keyboard, not only to a pointer', () => {
    // The regression this file exists for. The pencil was `opacity-0` with a
    // single `group-hover` wake, so a keyboard user tabbing onto the name saw
    // an unchanged line and was told nothing about renaming at all.
    renderHero();
    const button = screen.getByRole('button', { name: 'Rename Scout' });
    const pencil = button.querySelector('svg')!;

    expect(pencil.getAttribute('class')).toContain('group-hover/rename:opacity-100');
    expect(pencil.getAttribute('class')).toContain('group-focus-visible/rename:opacity-100');
    // And the control itself has to show focus at all for that wake to fire.
    expect(button.className.split(' ')).toContain('focus-ring');
  });

  it('leaves the avatar corner to the identity it belongs to', () => {
    // Nothing is stacked on the disc any more: the face answers a pointer with
    // a ring in the agent's own colour, which costs no corner.
    renderHero();
    const avatarButton = screen.getByTestId('avatar-picker-trigger');

    expect(avatarButton.querySelector('svg.lucide-pencil')).toBeNull();
    expect(avatarButton.className.split(' ')).toContain('group/identity');
    expect(avatarButton.className.split(' ')).toContain('focus-ring');
  });

  it('draws the agent’s health as words, never as a ring on the disc', () => {
    // Health left the disc entirely (DOR-1052). The hero is one of the two
    // surfaces that genuinely needs it, so it says it in a line of its own.
    renderHero();

    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(
      screen.getByTestId('avatar-picker-trigger').querySelector('[data-slot="agent-avatar"]')!
        .className
    ).not.toContain('ring-status-');
  });
});
