// @vitest-environment jsdom
/**
 * The dashboard hero composer, serialized — the pre-migration record.
 *
 * Captured from the unmigrated `DashboardComposerSection`, where
 * `<Composer.Input>` sits directly under the `<section>` with no card chrome
 * around it. After task 2.5 wraps it in `<Composer.Root>`, the diff against
 * this baseline must be EXACTLY one added element — the Root `div` — with the
 * previously top-level composer subtree hanging off it unchanged (spec
 * `composer-parity`, task 2.5).
 *
 * The real `ChatInput` renders here, unlike in `DashboardComposerSection.test.tsx`
 * next door, which stubs the composer barrel down to the callbacks it asserts.
 * A stub would make the baseline a record of the stub — and the whole claim
 * being made is about markup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { serializeDom, matchDomBaseline, formatDomDiff } from '@/test-helpers/dom-parity';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

// The registered ABSOLUTE path, matching the sibling suite's fixture.
vi.mock('@/layers/entities/config', () => ({
  useDefaultAgentSession: () => ({
    startSession: vi.fn(),
    defaultAgentDir: '/home/kai/.dork/agents/dorkbot',
    defaultAgentDisplayName: 'DorkBot',
    defaultAgentIdentity: {
      name: 'dorkbot',
      displayName: 'DorkBot',
      agentId: 'agent-ulid-1',
      runtime: 'claude-code',
    },
    isDefaultAgentResolved: true,
  }),
}));

import { DashboardComposerSection } from '../ui/DashboardComposerSection';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('DashboardComposerSection — serialized-DOM parity (pre-migration baseline)', () => {
  it('records the hero composer as it renders today, with no card chrome around it', () => {
    const { container } = render(<DashboardComposerSection />);

    // The three things the wrap must leave alone, asserted here so a baseline
    // that recorded an empty section would be caught before it was committed.
    expect(
      screen.getByRole('heading', { name: 'What are we building today?' })
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-label', 'Message DorkBot…');

    // Today the composer subtree is a DIRECT child of the section, right after
    // the heading. That adjacency is exactly what task 2.5's "exactly one added
    // element" claim is measured against.
    const section = container.querySelector('section')!;
    expect(section.children).toHaveLength(2);
    expect(section.children[0]!.tagName).toBe('H2');
    expect(section.children[1]!.className).not.toContain('rounded-xl');

    const diff = matchDomBaseline(
      import.meta.url,
      'dashboard-composer-section',
      serializeDom(container)
    );
    expect(formatDomDiff(diff)).toBe('');
  });

  it('has no dropzone: the dashboard passes no onAttach, so nothing mounts a file input', () => {
    // Recorded as a negative because the migration must NOT acquire one — the
    // capability matrix says the dashboard follows chat on attach, which means
    // it inherits the seam later, not that Root wires one now.
    const { container } = render(<DashboardComposerSection />);

    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach file' })).toBeNull();
    expect(container.querySelector('[role="presentation"]')).toBeNull();
  });
});
