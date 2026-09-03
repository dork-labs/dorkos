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
    subtitle: 'Anthropic · frontier models in the cloud',
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

  it('gives the summary the width of the card, not the width of the name column', async () => {
    // Inside the identity column it had the card's left third and wrapped to
    // three lines on a desktop while the right half sat empty. Its own row
    // beneath the identity, indented past the logo tile (design §4 composite).
    const user = userEvent.setup();
    const { onToggleExpanded } = renderCard();

    const summary = screen.getByTestId('runtime-card-summary-claude-code');
    expect(summary.closest('[data-testid="runtime-card-toggle-claude-code"]')).toBeNull();

    const row = screen.getByTestId('runtime-card-summary-toggle-claude-code');
    expect(row).toContainElement(summary);
    expect(row).toHaveClass('w-full', 'pl-12');

    // Still a way into the card: clicking the line opens it, as the design says
    // the header and the summary both do.
    await user.click(summary);
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);

    // A mouse shortcut, not a stop on the tab route: the identity button above
    // already carries this body for the keyboard.
    expect(row).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('runtime-card-toggle-claude-code')).toHaveAttribute('aria-expanded');
  });

  it('gives the not-ready sentence that same full row, with nothing to click', () => {
    renderCard({ ready: false, summary: [] });

    const locked = screen.getByTestId('runtime-card-locked-claude-code');
    expect(locked.parentElement).toHaveClass('w-full', 'pl-12');
    expect(screen.queryByTestId('runtime-card-summary-toggle-claude-code')).not.toBeInTheDocument();
  });

  it('reads the summary as one sentence: the lead-in, then the facts', () => {
    renderCard();

    const summary = screen.getByTestId('runtime-card-summary-claude-code');
    expect(summary).toHaveTextContent(/^Starts with\s*Opus 4\.6\s*·\s*Asks first$/);
  });

  it('says nothing about what a card with no facts starts with', () => {
    // An empty summary renders no line at all, so there is no orphaned lead-in.
    renderCard({ summary: [] });

    expect(screen.queryByTestId('runtime-card-summary-claude-code')).not.toBeInTheDocument();
    expect(screen.queryByText('Starts with')).not.toBeInTheDocument();
  });

  it('offers no lead-in on a card that cannot start a conversation', () => {
    renderCard({ ready: false, summary: [] });

    expect(screen.queryByText('Starts with')).not.toBeInTheDocument();
    expect(screen.getByTestId('runtime-card-locked-claude-code')).toBeInTheDocument();
  });

  it('keeps each separator with the fact it introduces, so a wrap cannot strand it', () => {
    // Two flex items would let "Automatic ·" end one line and "Asks
    // first" start the next. One item per pair makes that impossible.
    renderCard();

    const segments = screen.getAllByTestId(/^runtime-card-summary-segment-/);
    const second = segments[1]?.parentElement;
    expect(second).toHaveClass('inline-flex', 'whitespace-nowrap');
    expect(second?.textContent).toBe('·Asks first');

    // The first fact has no dot before it, so its pair is just the fact.
    expect(segments[0]?.parentElement?.textContent).toBe('Opus 4.6');
  });

  it('names the runtime it is, in one line beneath the name', () => {
    renderCard();
    expect(screen.getByText('Anthropic · frontier models in the cloud')).toBeInTheDocument();

    cleanup();
    renderCard({ subtitle: undefined });
    expect(screen.queryByText('Anthropic · frontier models in the cloud')).not.toBeInTheDocument();
  });

  it('never truncates the runtime’s name, whatever else is in the header', () => {
    // "Clau…" beside a Default pill is a card nobody can identify (design §6).
    renderCard({ isDefault: true, reconnect: { kind: 'login', onOpen: vi.fn() } });

    const name = screen.getByText('Claude Code');
    expect(name).toHaveClass('whitespace-nowrap');
    expect(name).not.toHaveClass('truncate');
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

    expect(screen.getByTestId('runtime-make-default-claude-code')).toHaveClass(
      'hidden',
      'sm:inline-flex'
    );
    expect(
      screen.getByTestId('runtime-make-default-compact-claude-code').parentElement
    ).toHaveClass('sm:hidden');
  });

  it('offers a runtime that is not connected Connect and nothing else', () => {
    // Settings unlock after connecting (design §1) — and the default runtime is
    // a setting. A card that cannot start a conversation cannot be where they
    // start.
    renderCard({
      ready: false,
      summary: [],
      expanded: true,
      setupDetails: <p>claude not found</p>,
    });

    expect(screen.queryByTestId('runtime-make-default-claude-code')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('runtime-make-default-compact-claude-code')
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make default' })).not.toBeInTheDocument();
  });

  it('moves the reconnect trigger into the body on a phone, exactly as Make default moves', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const { onToggleExpanded } = renderCard({
      expanded: true,
      reconnect: { kind: 'login', onOpen },
    });

    // The header keeps it from `sm` up; below that it competed with the name.
    expect(screen.getByTestId('runtime-reconnect-claude-code')).toHaveClass(
      'hidden',
      'sm:inline-flex'
    );
    const compact = screen.getByTestId('runtime-reconnect-compact-claude-code');
    expect(compact).toHaveTextContent('Fix sign-in');
    expect(compact.parentElement).toHaveClass('sm:hidden');

    await user.click(compact);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onToggleExpanded).not.toHaveBeenCalled();
  });

  it('names OpenCode’s compact trigger the way its header names it', () => {
    renderCard({
      type: 'opencode',
      expanded: true,
      reconnect: { kind: 'provider-picker', onOpen: vi.fn() },
    });

    expect(screen.getByTestId('runtime-change-compact-opencode')).toHaveTextContent('Change');
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

  it('warns before a working sign-in runs out, while the card still reads Ready', () => {
    // The point of the warning is that nothing is broken yet: the card is Ready,
    // and this is the window in which signing in again costs nothing.
    renderCard({ expiringSignIn: { expiresAt: '2026-09-20T04:51:04.000Z', timeLeft: '2 days' } });

    expect(screen.getByTestId('runtime-ready-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-sign-in-expiring-claude-code')).toHaveTextContent(
      'Your Claude Code sign-in runs out in 2 days. Sign in again before your agents stall.'
    );
  });

  it('drops the countdown for a plain warning once the sign-in is out of time', () => {
    // The card still reads Ready — truthfully, for a few more hours — so the
    // line has to carry the whole message on its own.
    renderCard({ expiringSignIn: { expiresAt: '2026-08-31T20:51:43.000Z', timeLeft: null } });

    expect(screen.getByTestId('runtime-ready-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-sign-in-expiring-claude-code')).toHaveTextContent(
      'Your Claude Code sign-in is out of time and will stop working shortly. Sign in again to avoid an interruption.'
    );
  });

  it('says nothing about expiry when no deadline is known — which is most of the time', () => {
    renderCard();

    expect(screen.queryByTestId('runtime-sign-in-expiring-claude-code')).not.toBeInTheDocument();
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

  it('says a runtime keeps no settings rather than drawing rows that write nowhere', () => {
    // A runtime that declares no `configSection` has nowhere to keep any of the
    // three: the model and effort writes fall on the floor, and so does the stop,
    // because the trust hook needs the same declaration. Three live-looking
    // controls that silently do nothing are worse than one honest line.
    renderCard({ expanded: true, storesDefaults: false });

    expect(screen.getByTestId('runtime-card-no-settings-claude-code')).toHaveTextContent(
      'Claude Code keeps no settings of its own.'
    );
    expect(screen.queryByTestId('runtime-model-select-claude-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId(/^runtime-effort-/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('runtime-trust-claude-code')).not.toBeInTheDocument();
  });

  it('keeps a sectionless runtime’s declared sections and setup details', () => {
    // Only the three standing rows go: a bespoke section owns its own write path,
    // and setup details are a read.
    renderCard({
      expanded: true,
      storesDefaults: false,
      sections: [{ kind: 'claude-accounts' }],
      renderSection: (kind) => <p>section: {kind}</p>,
      setupDetails: <p>claude binary found</p>,
    });

    expect(
      screen.getByTestId('runtime-card-section-claude-accounts-claude-code')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Setup details' })).toBeInTheDocument();
  });

  it('makes the chevron a declared second toggle, never a hidden one', async () => {
    // It was a `<button aria-hidden tabIndex={-1}>` — still clickable, still
    // programmatically focusable, and hidden from the tree that would explain it,
    // which is the one shape ARIA forbids outright. The fix is not to take the
    // click away but to declare it: a real button that says what it does.
    const user = userEvent.setup();
    const { onToggleExpanded } = renderCard();

    expect(document.querySelectorAll('button[aria-hidden]')).toHaveLength(0);
    expect(document.querySelectorAll('[aria-hidden] button')).toHaveLength(0);
    // Two controls for the one body now — the identity block and the chevron.
    expect(document.querySelectorAll('[aria-expanded]')).toHaveLength(2);

    const chevron = screen.getByTestId('runtime-card-chevron-claude-code');
    await user.click(chevron);
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it('gives the chevron the state and the name a keyboard user needs', () => {
    renderCard();

    const chevron = screen.getByTestId('runtime-card-chevron-claude-code');
    expect(chevron).toHaveAttribute('type', 'button');
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
    // In the tab order, unlike the summary line: it is a control, not a shortcut.
    expect(chevron).not.toHaveAttribute('tabindex');
    // Named by the runtime it opens, so two cards never read as the same button.
    expect(chevron).toHaveAccessibleName('Show Claude Code settings');
    expect(chevron).not.toHaveAttribute('aria-controls');

    cleanup();
    renderCard({ expanded: true });

    const open = screen.getByTestId('runtime-card-chevron-claude-code');
    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(open).toHaveAccessibleName('Hide Claude Code settings');
    // Only points at the body while there is a body in the document to point at.
    expect(open.getAttribute('aria-controls')).toBe(
      screen.getByTestId('runtime-card-body-claude-code').id
    );
  });

  it('names the not-ready chevron after setup, not settings it does not have', () => {
    // A locked card's body holds setup details; its own copy says settings
    // unlock once it's connected, so the button must not promise them.
    renderCard({ ready: false, setupDetails: <p>claude binary found</p> });

    expect(screen.getByTestId('runtime-card-chevron-claude-code')).toHaveAccessibleName(
      'Show Claude Code setup'
    );
  });

  it('offers no chevron on a card with nothing to open', () => {
    renderCard({ ready: false, summary: [] });

    expect(screen.queryByTestId('runtime-card-chevron-claude-code')).not.toBeInTheDocument();
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
