// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ModelOption } from '@dorkos/shared/types';
import { ModelRow } from '../rows/ModelRow';

beforeAll(() => {
  // Radix Select needs DOM APIs jsdom lacks to open its listbox under userEvent.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  if (!proto.scrollIntoView) proto.scrollIntoView = vi.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MODELS: ModelOption[] = [
  {
    value: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    description: 'Capable model',
    supportsEffort: true,
  },
  {
    value: 'haiku',
    displayName: 'Haiku',
    description: 'Small model',
    supportsEffort: false,
  },
];

function renderRow(props: Partial<Parameters<typeof ModelRow>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <ModelRow
      runtimeType="claude-code"
      runtimeLabel="Claude Code"
      models={MODELS}
      value={null}
      onChange={onChange}
      {...props}
    />
  );
  return { onChange };
}

describe('ModelRow', () => {
  it('scopes its test id to the runtime, so three cards can render the row at once', () => {
    renderRow({ runtimeType: 'codex', runtimeLabel: 'Codex' });
    expect(screen.getByTestId('runtime-model-select-codex')).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-model-select-claude-code')).not.toBeInTheDocument();
  });

  it("shows the runtime's choice when nothing is pinned", () => {
    renderRow();
    expect(screen.getByTestId('runtime-model-select-claude-code')).toHaveTextContent(
      "Runtime's choice"
    );
  });

  it('reports a catalog pick by its model id', async () => {
    const { onChange } = renderRow();
    await userEvent.click(screen.getByTestId('runtime-model-select-claude-code'));
    await userEvent.click(await screen.findByRole('option', { name: 'Opus 4.6' }));
    expect(onChange).toHaveBeenCalledWith('claude-opus-4-6');
  });

  it('reports the inherit option as null, never as its sentinel', async () => {
    // The sentinel exists only because Radix refuses an empty-string item value.
    // It must never reach a caller, or "no default" would be stored as a string.
    const { onChange } = renderRow({ value: 'claude-opus-4-6' });
    await userEvent.click(screen.getByTestId('runtime-model-select-claude-code'));
    await userEvent.click(await screen.findByRole('option', { name: "Runtime's choice" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('keeps a model the catalog no longer offers selectable rather than showing a blank', async () => {
    const { onChange } = renderRow({ value: 'opus-3' });
    const trigger = screen.getByTestId('runtime-model-select-claude-code');
    expect(trigger).toHaveTextContent('opus-3 (no longer offered)');

    // A real option in the list, not a dead label — carrying the selection, so
    // nothing silently swapped it for a model this person never chose.
    await userEvent.click(trigger);
    expect(
      await screen.findByRole('option', { name: 'opus-3 (no longer offered)' })
    ).toHaveAttribute('data-state', 'checked');
    expect(await screen.findByRole('option', { name: 'Opus 4.6' })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not call a model gone on a catalog nobody has fetched yet', () => {
    // Evidence nobody has is never evidence against (`knownModelsFrom`): a card
    // opened before its catalog arrives names the pinned model, and does not
    // accuse it of being retired for the length of one round-trip.
    renderRow({ models: undefined, value: 'claude-opus-4-6' });
    const trigger = screen.getByTestId('runtime-model-select-claude-code');
    expect(trigger).toHaveTextContent('claude-opus-4-6');
    expect(trigger).not.toHaveTextContent('no longer offered');
  });

  it('reads an EMPTY catalog as a warming one, not as a runtime that offers nothing', () => {
    renderRow({ models: [], value: 'claude-opus-4-6' });
    expect(screen.getByTestId('runtime-model-select-claude-code')).not.toHaveTextContent(
      'no longer offered'
    );
  });

  it('names the runtime in its own description', () => {
    renderRow({ runtimeType: 'opencode', runtimeLabel: 'OpenCode' });
    expect(screen.getByText(/Which OpenCode model a new conversation starts on/)).toBeVisible();
  });

  it('admits a capped, unconfirmed catalog instead of presenting it as the real list', () => {
    // Same fact the composer picker surfaces (DOR-1660): with no provider
    // connected every row arrives `unverified`, and a list that stays silent
    // about that reads as complete when it is a bounded guess (DOR-1674).
    renderRow({ models: MODELS.map((m) => ({ ...m, unverified: true })) });
    const notice = screen.getByTestId('model-catalog-unverified');
    expect(notice).toBeVisible();
    // The admission reaches a screen reader too: the trigger describes itself
    // by the notice, so navigating by control hears it, not only sees it.
    expect(screen.getByTestId('runtime-model-select-claude-code')).toHaveAttribute(
      'aria-describedby',
      notice.getAttribute('id')
    );
  });

  it('admits a mixed catalog when even one row is unconfirmed', () => {
    // `some`, not `every`: a single unverified row already means the list
    // contains guesses, and staying quiet about part of the list is the same
    // false completeness as staying quiet about all of it.
    renderRow({ models: [MODELS[0]!, { ...MODELS[1]!, unverified: true }] });
    expect(screen.getByTestId('model-catalog-unverified')).toBeVisible();
  });

  it('shows no unverified notice on a confirmed catalog', () => {
    renderRow();
    expect(screen.getByTestId('runtime-model-select-claude-code')).toBeInTheDocument();
    expect(screen.queryByTestId('model-catalog-unverified')).not.toBeInTheDocument();
  });

  it('accuses nothing while the catalog has not answered yet', () => {
    // An absent or empty catalog is a warming one, not an unconfirmed one —
    // the notice names a fact about rows that exist, so no rows, no notice.
    renderRow({ models: undefined });
    expect(screen.getByTestId('runtime-model-select-claude-code')).toBeInTheDocument();
    expect(screen.queryByTestId('model-catalog-unverified')).not.toBeInTheDocument();
    cleanup();
    renderRow({ models: [] });
    expect(screen.getByTestId('runtime-model-select-claude-code')).toBeInTheDocument();
    expect(screen.queryByTestId('model-catalog-unverified')).not.toBeInTheDocument();
  });
});
