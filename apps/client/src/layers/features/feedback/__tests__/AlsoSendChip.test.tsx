// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { AlsoSendChip } from '../ui/AlsoSendChip';

afterEach(cleanup);

function renderChip(pressed: boolean) {
  const onPressedChange = vi.fn();
  const onPreview = vi.fn();
  render(
    <TooltipProvider>
      <AlsoSendChip
        label="Diagnostics"
        summary="Version, window size, browser, and recent errors."
        pressed={pressed}
        onPressedChange={onPressedChange}
        onPreview={onPreview}
      />
    </TooltipProvider>
  );
  return { onPressedChange, onPreview };
}

describe('AlsoSendChip', () => {
  it('is a real toggle that says whether it is on', () => {
    renderChip(true);
    expect(screen.getByRole('button', { name: 'Diagnostics' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('asks to flip its state when pressed', () => {
    const { onPressedChange } = renderChip(false);
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    expect(onPressedChange).toHaveBeenCalledWith(true);
  });

  it('opens the preview from a labelled eye button, without toggling', () => {
    const { onPressedChange, onPreview } = renderChip(true);
    fireEvent.click(screen.getByRole('button', { name: 'Preview diagnostics' }));
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPressedChange).not.toHaveBeenCalled();
  });
});
