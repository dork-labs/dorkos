// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ModelOption } from '@dorkos/shared/types';
import { EffortRow } from '../rows/EffortRow';

beforeAll(() => {
  // Radix Select needs DOM APIs jsdom lacks to open its listbox under userEvent
  // — the same shims the Model row's tests install, for the same control.
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

const OPUS: ModelOption = {
  value: 'claude-opus-4-6',
  displayName: 'Opus 4.6',
  description: 'Capable model',
  supportsEffort: true,
};

const HAIKU: ModelOption = {
  value: 'haiku',
  displayName: 'Haiku',
  description: 'Small model',
  supportsEffort: false,
};

function renderRow(props: Partial<Parameters<typeof EffortRow>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <EffortRow
      runtimeType="claude-code"
      runtimeLabel="Claude Code"
      supportsEffort
      selectedModel={OPUS}
      configuredModelId={OPUS.value}
      value={null}
      onChange={onChange}
      {...props}
    />
  );
  return { onChange };
}

/** A four-rung ladder — the design's case, and the one that stays segmented. */
const SHORT_LADDER: ModelOption = {
  ...OPUS,
  supportedEffortLevels: ['low', 'medium', 'high', 'max'],
};

describe('EffortRow', () => {
  it('offers a short ladder as one segmented control, scoped to its runtime', () => {
    renderRow({ runtimeType: 'codex', runtimeLabel: 'Codex', selectedModel: SHORT_LADDER });
    expect(screen.getByTestId('runtime-effort-codex')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'High' })).toBeInTheDocument();
  });

  it('reports a rung by its level', async () => {
    const { onChange } = renderRow({ selectedModel: SHORT_LADDER });
    await userEvent.click(screen.getByRole('radio', { name: 'High' }));
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it("reports the runtime's-choice segment as null, never as its sentinel", async () => {
    const { onChange } = renderRow({ selectedModel: SHORT_LADDER, value: 'high' });
    await userEvent.click(screen.getByRole('radio', { name: 'Automatic' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('offers only the rungs the selected model accepts', () => {
    renderRow({
      selectedModel: { ...OPUS, supportedEffortLevels: ['low', 'medium', 'high'] },
    });
    expect(screen.getByRole('radio', { name: 'Low' })).toBeInTheDocument();
    // `max` and `xhigh` are rungs other models take and this one does not.
    expect(screen.queryByRole('radio', { name: 'Max' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Extra high' })).not.toBeInTheDocument();
  });

  it('asks a long ladder as a menu, because eight segments are eight ellipses', () => {
    // Claude Code's catalog answers with every rung, which is eight positions in
    // a settings dialog barely 400px wide: "N…", "Min…", "Me…". Same choices,
    // same test id, a control that survives the width.
    renderRow({ selectedModel: undefined, configuredModelId: 'claude-opus-4-6' });

    const trigger = screen.getByTestId('runtime-effort-claude-code');
    expect(trigger).toHaveRole('combobox');
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('Automatic');
  });

  it('keeps every rung of a long ladder reachable in the menu', async () => {
    renderRow({ selectedModel: undefined, configuredModelId: 'claude-opus-4-6' });

    await userEvent.click(screen.getByTestId('runtime-effort-claude-code'));
    const options = screen.getAllByRole('option').map((el) => el.textContent);
    expect(options).toEqual([
      'Automatic',
      'None',
      'Minimal',
      'Low',
      'Medium',
      'High',
      'Max',
      'Extra high',
    ]);
  });

  it('writes through from the menu exactly as it does from the ladder', async () => {
    const { onChange } = renderRow({
      selectedModel: undefined,
      configuredModelId: 'claude-opus-4-6',
      value: 'high',
    });

    await userEvent.click(screen.getByTestId('runtime-effort-claude-code'));
    await userEvent.click(screen.getByRole('option', { name: 'Max' }));
    expect(onChange).toHaveBeenCalledWith('max');

    await userEvent.click(screen.getByTestId('runtime-effort-claude-code'));
    await userEvent.click(screen.getByRole('option', { name: 'Automatic' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('leaves the whole ladder up while the catalog entry has not arrived', () => {
    // Evidence nobody has is never evidence against: an unknown model narrows
    // nothing, so the rung somebody already chose is never quietly dropped.
    renderRow({ selectedModel: undefined, configuredModelId: 'claude-opus-4-6', value: 'max' });
    expect(screen.getByTestId('runtime-effort-claude-code')).toHaveTextContent('Max');
  });

  it('says the runtime has no such setting rather than hiding the row', () => {
    renderRow({
      runtimeType: 'opencode',
      runtimeLabel: 'OpenCode',
      supportsEffort: false,
      selectedModel: undefined,
      configuredModelId: null,
    });
    expect(screen.getByTestId('runtime-effort-unsupported-opencode')).toHaveTextContent(
      'Not supported by OpenCode'
    );
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('names the MODEL when the runtime takes an effort and the model does not', () => {
    // Named after the model, because that is the row a person would change to
    // get the setting back.
    renderRow({ selectedModel: HAIKU, configuredModelId: 'haiku' });
    expect(screen.getByTestId('runtime-effort-model-unsupported-claude-code')).toHaveTextContent(
      "Haiku doesn't take an effort setting"
    );
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('lets an effort stranded on such a model be cleared in one tap', async () => {
    const { onChange } = renderRow({
      selectedModel: HAIKU,
      configuredModelId: 'haiku',
      value: 'high',
    });
    const clear = screen.getByTestId('runtime-effort-clear-claude-code');
    expect(clear).toHaveTextContent('High is saved here and does nothing. Clear it');
    await userEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('freezes whichever control it drew when the write has nowhere to go', async () => {
    const { onChange } = renderRow({ selectedModel: SHORT_LADDER, disabled: true });
    const rung = screen.getByRole('radio', { name: 'High' });
    expect(rung).toBeDisabled();
    await userEvent.click(rung);
    expect(onChange).not.toHaveBeenCalled();

    cleanup();
    renderRow({ selectedModel: undefined, configuredModelId: 'claude-opus-4-6', disabled: true });
    const menu = screen.getByTestId('runtime-effort-claude-code');
    expect(menu).toBeDisabled();
    await userEvent.click(menu);
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('freezes the offer to clear a stranded effort too', async () => {
    const { onChange } = renderRow({
      selectedModel: HAIKU,
      configuredModelId: 'haiku',
      value: 'high',
      disabled: true,
    });
    const clear = screen.getByTestId('runtime-effort-clear-claude-code');
    expect(clear).toBeDisabled();
    await userEvent.click(clear);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('offers nothing to clear when nothing is stranded', () => {
    renderRow({ selectedModel: HAIKU, configuredModelId: 'haiku', value: null });
    expect(screen.queryByTestId('runtime-effort-clear-claude-code')).not.toBeInTheDocument();
  });
});
