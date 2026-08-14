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
  mcpServers: [],
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
   * The rung name DOR-773 restored to the picker — a bare label, not a
   * sentence, because the trigger portals a `SelectItem`'s children verbatim
   * into a fixed-width `whitespace-nowrap` box (Radix `SelectItemText` →
   * `context.valueNode`) with no wrap and no ellipsis on overflow.
   */
  const ENGAGED_LABEL = 'Engaged';

  it('shows a stored engaged mode as "Engaged" rather than blanking the control', () => {
    render(
      <PersonalityTab
        agent={{ ...mockAgent, behavior: { responseMode: 'engaged' as const } }}
        soulContent="soul"
        nopeContent="nope"
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByText(ENGAGED_LABEL)).toBeInTheDocument();
  });

  it('offers engaged as a fresh choice, ordered loud to quiet with the other four', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent="soul" nopeContent="nope" onUpdate={vi.fn()} />
    );

    // DOR-773: engaged was withheld on a premise
    // decisions/260730-182745-response-mode-is-projected-onto-loudness-rungs.md
    // records as false (a direct message's engaged window opens exactly as a
    // channel's does), so it is now offered like every other stored value —
    // between direct-only and mention-only, the same loud-to-quiet order as
    // RESPONSE_RUNGS in entities/room/lib/response-mode.ts.
    expect(offeredModes()).toEqual([
      'Always respond',
      'Direct messages only',
      ENGAGED_LABEL,
      'Only when mentioned',
      'Never respond automatically',
    ]);
  });

  it('commits engaged when the reader picks it', () => {
    const onUpdate = vi.fn();
    render(
      <PersonalityTab agent={mockAgent} soulContent="soul" nopeContent="nope" onUpdate={onUpdate} />
    );

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    fireEvent.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: ENGAGED_LABEL })
    );

    expect(onUpdate).toHaveBeenCalledWith({
      behavior: { responseMode: 'engaged' },
    });
  });

  it('scopes engaged honestly: new direct messages only, never a channel or an already-configured room', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent="soul" nopeContent="nope" onUpdate={vi.fn()} />
    );

    expect(
      screen.getByText(
        "Engaged only sets what a new direct message starts as: a channel always starts engaged, and a room you've already set up keeps what it has.",
        { exact: false }
      )
    ).toBeInTheDocument();
  });

  it('renders with null convention content without crashing', () => {
    render(
      <PersonalityTab agent={mockAgent} soulContent={null} nopeContent={null} onUpdate={vi.fn()} />
    );

    expect(screen.getByTestId('trait-sliders')).toBeInTheDocument();
    expect(screen.getByTestId('injection-preview')).toBeInTheDocument();
  });
});
