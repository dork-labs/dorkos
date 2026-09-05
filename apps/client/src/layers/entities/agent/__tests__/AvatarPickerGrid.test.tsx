/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { AvatarColorGrid, AvatarEmojiGrid } from '../ui/AvatarPickerGrid';

function renderWithTooltips(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('AvatarColorGrid', () => {
  describe('hover preview seam', () => {
    it('fires onHoverChange with the hex on mouseEnter and null on mouseLeave', () => {
      const onHoverChange = vi.fn();
      const { getByLabelText } = renderWithTooltips(
        <AvatarColorGrid
          value={null}
          autoColor="hsl(200, 70%, 55%)"
          onSelect={vi.fn()}
          onHoverChange={onHoverChange}
        />
      );

      const redSwatch = getByLabelText('Select Red');
      fireEvent.mouseEnter(redSwatch);
      expect(onHoverChange).toHaveBeenCalledWith('#ef4444');

      fireEvent.mouseLeave(redSwatch);
      expect(onHoverChange).toHaveBeenCalledWith(null);
    });

    it('does not throw when onHoverChange is omitted', () => {
      const { getByLabelText } = renderWithTooltips(
        <AvatarColorGrid value={null} autoColor="hsl(200, 70%, 55%)" onSelect={vi.fn()} />
      );

      const redSwatch = getByLabelText('Select Red');
      expect(() => {
        fireEvent.mouseEnter(redSwatch);
        fireEvent.mouseLeave(redSwatch);
      }).not.toThrow();
    });
  });

  describe('selection burst', () => {
    it('renders no checkmark burst when justSelectedKey is omitted', () => {
      const { container } = renderWithTooltips(
        <AvatarColorGrid value="#ef4444" autoColor="hsl(200, 70%, 55%)" onSelect={vi.fn()} />
      );

      expect(container.querySelector('.lucide-check')).not.toBeInTheDocument();
    });

    it('renders a checkmark burst only over the swatch matching justSelectedKey', () => {
      const { getByLabelText } = renderWithTooltips(
        <AvatarColorGrid
          value="#ef4444"
          autoColor="hsl(200, 70%, 55%)"
          onSelect={vi.fn()}
          justSelectedKey="#ef4444"
        />
      );

      const redSwatch = getByLabelText('Select Red');
      const orangeSwatch = getByLabelText('Select Orange');
      expect(redSwatch.querySelector('.lucide-check')).toBeInTheDocument();
      expect(orangeSwatch.querySelector('.lucide-check')).not.toBeInTheDocument();
    });
  });

  describe('celebratory gate — behavior preservation (DOR-970)', () => {
    it('renders a plain, tooltip-free, glow-free swatch by default (settings form)', () => {
      const { container, queryByText } = renderWithTooltips(
        <AvatarColorGrid value={null} autoColor="hsl(200, 70%, 55%)" onSelect={vi.fn()} />
      );

      expect(container.querySelector('[data-slot="tooltip-trigger"]')).not.toBeInTheDocument();
      expect(container.querySelector('.blur-md')).not.toBeInTheDocument();
      // The dashed-ring "A" glyph convention, not the celebratory Wand2 icon.
      expect(queryByText('A')).toBeInTheDocument();
    });

    it('renders tooltips and a hover glow when celebratory (AvatarPickerPanel)', () => {
      const { container } = renderWithTooltips(
        <AvatarColorGrid
          value={null}
          autoColor="hsl(200, 70%, 55%)"
          onSelect={vi.fn()}
          celebratory
        />
      );

      expect(container.querySelector('[data-slot="tooltip-trigger"]')).toBeInTheDocument();
      expect(container.querySelector('.blur-md')).toBeInTheDocument();
    });

    it('lets the auto swatch presentation be overridden independently of celebratory', () => {
      const { getByLabelText, queryByText } = renderWithTooltips(
        <AvatarColorGrid
          value={null}
          autoColor="hsl(200, 70%, 55%)"
          onSelect={vi.fn()}
          celebratory
          autoIcon={<span data-testid="custom-auto-icon" />}
          autoLabel="Custom auto label"
        />
      );

      expect(getByLabelText('Custom auto label')).toBeInTheDocument();
      expect(queryByText('A')).not.toBeInTheDocument();
    });
  });
});

describe('AvatarEmojiGrid', () => {
  it('calls onSelect with the clicked emoji', () => {
    const onSelect = vi.fn();
    const { getByLabelText } = renderWithTooltips(
      <AvatarEmojiGrid value="😀" autoEmoji="😀" hasOverride={false} onSelect={onSelect} />
    );

    fireEvent.click(getByLabelText('Select icon 😎'));
    expect(onSelect).toHaveBeenCalledWith('😎');
  });

  it('marks the auto-default emoji with a dashed ring by default, solid when celebratory', () => {
    const { getByLabelText, rerender } = renderWithTooltips(
      <AvatarEmojiGrid value="😀" autoEmoji="😀" hasOverride={false} onSelect={vi.fn()} />
    );
    expect(getByLabelText('Select icon 😀').className).toContain('ring-dashed');

    rerender(
      <TooltipProvider>
        <AvatarEmojiGrid
          value="😀"
          autoEmoji="😀"
          hasOverride={false}
          onSelect={vi.fn()}
          celebratory
        />
      </TooltipProvider>
    );
    expect(getByLabelText('Select icon 😀').className).not.toContain('ring-dashed');
  });

  it('renders no checkmark burst when justSelectedKey is omitted', () => {
    const { container } = renderWithTooltips(
      <AvatarEmojiGrid value="😀" autoEmoji="😀" hasOverride={false} onSelect={vi.fn()} />
    );
    expect(container.querySelector('.lucide-check')).not.toBeInTheDocument();
  });
});
