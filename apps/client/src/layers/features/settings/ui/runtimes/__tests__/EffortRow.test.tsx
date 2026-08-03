// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ModelOption } from '@dorkos/shared/types';
import { EffortRow } from '../rows/EffortRow';

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

describe('EffortRow', () => {
  it('offers the ladder as one segmented control, scoped to its runtime', () => {
    renderRow({ runtimeType: 'codex', runtimeLabel: 'Codex' });
    expect(screen.getByTestId('runtime-effort-codex')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'High' })).toBeInTheDocument();
  });

  it('reports a rung by its level', async () => {
    const { onChange } = renderRow();
    await userEvent.click(screen.getByRole('radio', { name: 'High' }));
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it("reports the runtime's-choice segment as null, never as its sentinel", async () => {
    const { onChange } = renderRow({ value: 'high' });
    await userEvent.click(screen.getByRole('radio', { name: "Runtime's choice" }));
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

  it('leaves the whole ladder up while the catalog entry has not arrived', () => {
    // Evidence nobody has is never evidence against: an unknown model narrows
    // nothing, so the rung somebody already chose is never quietly dropped.
    renderRow({ selectedModel: undefined, configuredModelId: 'claude-opus-4-6', value: 'max' });
    expect(screen.getByRole('radio', { name: 'Max' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Max' })).toBeChecked();
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
    expect(clear).toHaveTextContent('High is saved here and does nothing — clear it');
    await userEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('offers nothing to clear when nothing is stranded', () => {
    renderRow({ selectedModel: HAIKU, configuredModelId: 'haiku', value: null });
    expect(screen.queryByTestId('runtime-effort-clear-claude-code')).not.toBeInTheDocument();
  });
});
