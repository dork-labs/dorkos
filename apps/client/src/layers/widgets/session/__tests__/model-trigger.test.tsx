// @vitest-environment jsdom
/**
 * "Choose model" from a model error card (DOR-3074): in a session it clicks the
 * picker on the status line; in a DM, which has none, it opens the session
 * behind the DM and then the picker there.
 */
import { createRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';

const openSessionView = vi.fn();
vi.mock('@/layers/features/direct-message', () => ({
  useSessionViewLinks: () => ({ openSessionView, openDirectMessage: vi.fn() }),
}));

import { useChooseModel } from '../model/model-trigger';

/** A chat panel, with or without the picker's trigger drawn in it yet. */
function panelWith(trigger: boolean) {
  const panel = document.createElement('div');
  const onClick = vi.fn();
  if (trigger) panel.appendChild(pickerTrigger(onClick));
  document.body.appendChild(panel);
  return { panel, onClick };
}

function pickerTrigger(onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.dataset.testid = 'model-config-trigger';
  button.addEventListener('click', onClick);
  return button;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('useChooseModel', () => {
  it('clicks the picker on the status line in a session', () => {
    const { panel, onClick } = panelWith(true);
    const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
    ref.current = panel;

    const { result } = renderHook(() => useChooseModel(ref, false));
    result.current();

    expect(onClick).toHaveBeenCalledOnce();
    expect(openSessionView).not.toHaveBeenCalled();
  });

  it('opens the session view from a DM, then the picker once it is drawn', async () => {
    const { panel } = panelWith(false);
    const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
    ref.current = panel;

    const { result } = renderHook(() => useChooseModel(ref, true));
    result.current();
    expect(openSessionView).toHaveBeenCalledOnce();

    // The session view draws its status line, and with it the picker.
    const onClick = vi.fn();
    panel.appendChild(pickerTrigger(onClick));
    await waitFor(() => expect(onClick).toHaveBeenCalledOnce());
  });
});
