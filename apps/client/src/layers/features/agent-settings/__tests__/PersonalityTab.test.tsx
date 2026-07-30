/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
// Mock useDebouncedInput before importing PersonalityTab (prevents Zustand app-store init)
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useDebouncedInput: (serverValue: string) => ({
      value: serverValue,
      onChange: vi.fn(),
      onBlur: vi.fn(),
    }),
  };
});

import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { PersonalityTab } from '../ui/PersonalityTab';

// Mock child components to isolate PersonalityTab tests
vi.mock('@/layers/entities/agent', () => ({
  TraitSliders: ({ traits }: { traits: Record<string, number> }) => (
    <div data-testid="trait-sliders" data-traits={JSON.stringify(traits)} />
  ),
}));
vi.mock('../ui/ConventionFileEditor', () => ({
  ConventionFileEditor: ({ title }: { title: string }) => <div data-testid={`editor-${title}`} />,
}));
vi.mock('../ui/InjectionPreview', () => ({
  InjectionPreview: () => <div data-testid="injection-preview" />,
}));
vi.mock('@dorkos/shared/convention-files', () => ({
  SOUL_MAX_CHARS: 4000,
  NOPE_MAX_CHARS: 2000,
  extractCustomProse: vi.fn((content: string) => content),
  buildSoulContent: vi.fn((t: string, p: string) => `traits:${t}\n${p}`),
  TRAIT_SECTION_START: '<!-- TRAITS:START -->',
}));
vi.mock('@dorkos/shared/trait-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/trait-renderer')>()),
  renderTraits: vi.fn(() => 'rendered'),
  TRAIT_ORDER: ['verbosity', 'autonomy', 'chaos', 'creativity', 'humor', 'spice'],
  TRAIT_PREVIEWS: {
    verbosity: { 3: 'Balanced verbosity.' },
    autonomy: { 3: 'Balanced autonomy.' },
    chaos: { 3: 'Balanced chaos.' },
    creativity: { 3: 'Balanced creativity.' },
    humor: { 3: 'Balanced humor.' },
    spice: { 3: 'Balanced spice.' },
  },
}));
vi.mock('@/layers/shared/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib')>();
  return {
    ...actual,
    playSliderTick: vi.fn(),
  };
});

const mockAgent = {
  id: 'test-id',
  name: 'test-agent',
  description: 'A test agent',
  capabilities: [],
  runtime: 'claude-code' as const,
  behavior: { responseMode: 'always' as const },
  registeredAt: new Date().toISOString(),
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
};

// Radix Select drives itself with pointer capture and scrolls the highlighted
// option into view — browser APIs jsdom does not implement, and without them the
// listbox never opens, so the closed trigger is all a test can see.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

/** Open the response-mode menu and read back every option it offers. */
function offeredModes(): string[] {
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  return within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
}

describe('PersonalityTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders personality summary', () => {
    render(
      <PersonalityTab
        agent={mockAgent}
        soulContent="soul content"
        nopeContent="nope content"
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByText(/Balanced verbosity\./)).toBeInTheDocument();
  });

  it('renders trait sliders, editors, and injection preview', () => {
    render(
      <PersonalityTab
        agent={mockAgent}
        soulContent="soul content"
        nopeContent="nope content"
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByTestId('trait-sliders')).toBeInTheDocument();
    expect(screen.getByTestId('editor-Custom Instructions (SOUL.md)')).toBeInTheDocument();
    expect(screen.getByTestId('editor-Safety Boundaries (NOPE.md)')).toBeInTheDocument();
    expect(screen.getByTestId('injection-preview')).toBeInTheDocument();
  });

  it('renders dorkosKnowledge toggle', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent="soul" nopeContent="nope" onUpdate={vi.fn()} />
    );

    expect(
      screen.getByRole('switch', { name: 'Toggle DorkOS knowledge base injection' })
    ).toBeInTheDocument();
    expect(screen.getByText('DorkOS Knowledge Base')).toBeInTheDocument();
  });

  it('shows reset button only when traits differ from defaults', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent="soul" nopeContent="nope" onUpdate={vi.fn()} />
    );

    // All traits at default (3) — reset button should not appear
    expect(screen.queryByText('Reset to defaults')).not.toBeInTheDocument();
  });

  it('shows reset button when traits are non-default', () => {
    const agentWithTraits = {
      ...mockAgent,
      traits: { ...DEFAULT_TRAITS, verbosity: 1, autonomy: 5 },
    };
    render(
      <PersonalityTab
        agent={agentWithTraits}
        soulContent="soul"
        nopeContent="nope"
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByText('Reset to defaults')).toBeInTheDocument();
  });

  it('renders response mode selector with current value', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent="soul" nopeContent="nope" onUpdate={vi.fn()} />
    );

    expect(screen.getByText('Response Mode')).toBeInTheDocument();
    expect(screen.getByText('Always respond')).toBeInTheDocument();
  });

  /**
   * The blank-control failure, pinned from both sides.
   *
   * `UpdateAgentRequestSchema` `.pick()`s `behavior` off the manifest whole, so
   * `PATCH /api/mesh/agents/:id` accepts the full `ResponseModeSchema` — this
   * value is reachable without any UI ever offering it, and a Select with no
   * matching item renders its trigger empty.
   */
  it('shows a stored engaged mode rather than blanking the control', () => {
    render(
      <PersonalityTab
        agent={{ ...mockAgent, behavior: { responseMode: 'engaged' as const } }}
        soulContent="soul"
        nopeContent="nope"
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByText('Stays in the conversation (per room)')).toBeInTheDocument();
  });

  it('does not offer engaged as a fresh choice, because it only seeds a DM here', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent="soul" nopeContent="nope" onUpdate={vi.fn()} />
    );

    // Four options and no fifth: at the manifest level `engaged` would seed a
    // direct message, where the window never opens. A person picks it per room.
    expect(offeredModes()).toEqual([
      'Always respond',
      'Direct messages only',
      'Only when mentioned',
      'Never respond automatically',
    ]);
  });

  it('offers the fifth only to the agent that already stores it', () => {
    render(
      <PersonalityTab
        agent={{ ...mockAgent, behavior: { responseMode: 'engaged' as const } }}
        soulContent="soul"
        nopeContent="nope"
        onUpdate={vi.fn()}
      />
    );

    expect(offeredModes()).toContain('Stays in the conversation (per room)');
  });

  it('renders with null convention content without crashing', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent={null} nopeContent={null} onUpdate={vi.fn()} />
    );

    expect(screen.getByTestId('trait-sliders')).toBeInTheDocument();
    expect(screen.getByTestId('injection-preview')).toBeInTheDocument();
  });
});
