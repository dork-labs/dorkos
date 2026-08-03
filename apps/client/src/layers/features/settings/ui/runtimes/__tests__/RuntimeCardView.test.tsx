// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { RuntimeCardView, type RuntimeCardViewProps } from '../RuntimeCardView';
import type { RuntimeSummarySegment } from '../RuntimeCardSummary';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A settled card's summary: one set value and one inherited one. */
const SUMMARY: RuntimeSummarySegment[] = [
  { kind: 'model', label: 'Opus 4.6', inherited: false },
  { kind: 'trust', label: 'Asks first', inherited: true },
];

function renderCard(overrides: Partial<RuntimeCardViewProps> = {}) {
  const spies = {
    onToggleExpanded: vi.fn(),
    onMakeDefault: vi.fn(),
    onModelChange: vi.fn(),
    onEffortChange: vi.fn(),
    onTrustChange: vi.fn(),
    onReconnect: vi.fn(),
  };
  const props: RuntimeCardViewProps = {
    type: 'claude-code',
    subtitle: 'Anthropic’s coding agent',
    ready: true,
    isDefault: false,
    expanded: false,
    onToggleExpanded: spies.onToggleExpanded,
    onMakeDefault: spies.onMakeDefault,
    summary: SUMMARY,
    model: { models: undefined, value: null, onChange: spies.onModelChange },
    effort: {
      supportsEffort: false,
      selectedModel: undefined,
      configuredModelId: null,
      value: null,
      onChange: spies.onEffortChange,
    },
    trust: { descriptors: [], stop: null, globalStop: 'ask', onChange: spies.onTrustChange },
    ...overrides,
  };
  render(<RuntimeCardView {...props} />);
  return spies;
}

describe('RuntimeCardView', () => {
  it('talks in a summary at rest and in rows once opened, never both', () => {
    renderCard();

    const summary = screen.getByTestId('runtime-card-summary-claude-code');
    expect(summary).toHaveTextContent('Opus 4.6');
    expect(summary).toHaveTextContent('Asks first');
    expect(screen.queryByTestId('runtime-model-select-claude-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runtime-trust-claude-code')).not.toBeInTheDocument();

    cleanup();
    renderCard({ expanded: true });

    expect(screen.queryByTestId('runtime-card-summary-claude-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('runtime-model-select-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-effort-unsupported-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-trust-claude-code')).toBeInTheDocument();
  });

  it('marks an inherited summary value as inherited so the view can quiet it', () => {
    renderCard();

    const segments = within(screen.getByTestId('runtime-card-summary-claude-code')).getAllByTestId(
      /^runtime-card-summary-segment-/
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveAttribute('data-inherited', 'false');
    expect(segments[1]).toHaveAttribute('data-inherited', 'true');
  });

  it('shows the Default pill on the default card and offers no way to re-choose it', () => {
    renderCard({ isDefault: true });

    expect(screen.getByTestId('runtime-default-pill-claude-code')).toHaveTextContent('Default');
    expect(screen.queryByRole('button', { name: 'Make default' })).not.toBeInTheDocument();
  });

  it('offers Make default on the others, and choosing it does not swallow the card open', async () => {
    const user = userEvent.setup();
    const { onMakeDefault, onToggleExpanded } = renderCard();

    await user.click(screen.getByTestId('runtime-make-default-claude-code'));

    expect(onMakeDefault).toHaveBeenCalledTimes(1);
    expect(onToggleExpanded).not.toHaveBeenCalled();
  });

  it('moves Make default into the body as well, for the widths with no room in the header', () => {
    renderCard({ expanded: true });

    expect(screen.getByTestId('runtime-make-default-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-make-default-compact-claude-code')).toBeInTheDocument();
  });

  it('says a broken default out loud: the pill, the warning, and Connect together', () => {
    renderCard({
      isDefault: true,
      ready: false,
      summary: [],
      connectSlot: <button type="button">Sign in to Claude Code</button>,
    });

    expect(screen.getByTestId('runtime-default-pill-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-default-broken-claude-code')).toHaveTextContent(
      /default runtime isn’t connected/i
    );
    expect(screen.getByRole('button', { name: 'Sign in to Claude Code' })).toBeInTheDocument();
  });

  it('replaces a not-ready card’s summary with the one sentence that is true', () => {
    renderCard({ ready: false, summary: [], expanded: true });

    expect(screen.getByTestId('runtime-card-locked-claude-code')).toHaveTextContent(
      'One sign-in away. Settings unlock once it’s connected.'
    );
    expect(screen.queryByTestId('runtime-card-summary-claude-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runtime-model-select-claude-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runtime-effort-unsupported-claude-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runtime-trust-claude-code')).not.toBeInTheDocument();
  });

  it('renders declared sections in declared order and leaves no box where one renders nothing', () => {
    renderCard({
      expanded: true,
      sections: [{ kind: 'claude-accounts' }, { kind: 'nothing-to-say' }, { kind: 'later' }],
      renderSection: (kind) => (kind === 'nothing-to-say' ? null : <p>section: {kind}</p>),
    });

    const body = screen.getByTestId('runtime-card-body-claude-code');
    const rendered = within(body).getAllByTestId(/^runtime-card-section-/);
    expect(rendered.map((el) => el.getAttribute('data-testid'))).toEqual([
      'runtime-card-section-claude-accounts-claude-code',
      'runtime-card-section-later-claude-code',
    ]);
    expect(
      screen.queryByTestId('runtime-card-section-nothing-to-say-claude-code')
    ).not.toBeInTheDocument();
  });

  it('toggles from the header, and never from a control inside the body', async () => {
    const user = userEvent.setup();
    const onTrustChange = vi.fn();
    const { onToggleExpanded } = renderCard({
      expanded: true,
      trust: { descriptors: [], stop: 'act', globalStop: 'ask', onChange: onTrustChange },
    });

    await user.click(screen.getByTestId('runtime-card-toggle-claude-code'));
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);

    // The control does its own job and nothing else: the card stays open.
    await user.click(screen.getByRole('button', { name: 'Use the setting above' }));
    expect(onTrustChange).toHaveBeenCalledWith(null);
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it('keeps the quiet reconnect affordance a ready runtime already had', async () => {
    const user = userEvent.setup();
    const { onReconnect, onToggleExpanded } = renderCard({
      reconnect: { kind: 'login', onOpen: vi.fn() },
    });
    expect(screen.getByTestId('runtime-reconnect-claude-code')).toHaveTextContent('Fix sign-in');

    cleanup();
    renderCard({
      type: 'opencode',
      reconnect: { kind: 'provider-picker', onOpen: onReconnect },
    });
    const change = screen.getByTestId('runtime-change-opencode');
    expect(change).toHaveTextContent('Change');

    await user.click(change);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onToggleExpanded).not.toHaveBeenCalled();
  });

  it('offers nothing to reopen when no connect flow was supplied', () => {
    renderCard();

    expect(screen.getByTestId('runtime-ready-claude-code')).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-reconnect-claude-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runtime-change-claude-code')).not.toBeInTheDocument();
  });

  it('discloses setup details without opening them, and only when there are any', async () => {
    const user = userEvent.setup();
    renderCard({ expanded: true, setupDetails: <p>claude binary found</p> });

    expect(screen.queryByText('claude binary found')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Setup details' }));
    expect(screen.getByText('claude binary found')).toBeInTheDocument();

    cleanup();
    renderCard({ expanded: true });
    expect(screen.queryByRole('button', { name: 'Setup details' })).not.toBeInTheDocument();
  });

  it('does not promise an expansion a not-ready card with nothing to show cannot keep', () => {
    renderCard({ ready: false, summary: [] });

    expect(screen.queryByTestId('runtime-card-toggle-claude-code')).not.toBeInTheDocument();
  });
});
