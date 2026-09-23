// @vitest-environment jsdom
//
// jsdom limit worth naming: nothing here settles how the toolbar LOOKS or where
// its tooltips land — that is geometry and paint, which jsdom reports as 0x0.
// What is asserted is which control exists, what it is called, and what it calls
// back with — the parts that are this component's own decisions.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { ComposerToolbar } from '../ui/ComposerToolbar';

type ToolbarProps = Parameters<typeof ComposerToolbar>[0];

afterEach(cleanup);

function renderToolbar(overrides: Partial<ToolbarProps> = {}) {
  const props: ToolbarProps = {
    showPictureTools: true,
    isPreparing: false,
    hasPointed: false,
    hasWords: false,
    isMobile: false,
    onCapture: vi.fn(),
    onPointAtElement: vi.fn(),
    onPick: vi.fn(),
    ...overrides,
  };
  render(
    <TooltipProvider>
      <ComposerToolbar {...props} />
    </TooltipProvider>
  );
  return props;
}

describe('ComposerToolbar — the image picker', () => {
  it('offers a labelled image-only file input a keyboard can reach', () => {
    renderToolbar();
    const input = screen.getByLabelText('Add an image');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*');
    // `sr-only` hides it visually but leaves it in the tab order; `hidden` or
    // `display:none` would take the only keyboard route to the picker away.
    expect(input).not.toHaveAttribute('hidden');
  });

  it('describes the picker, on the element that takes focus, in the words of its tooltip', () => {
    renderToolbar();
    expect(screen.getByLabelText('Add an image')).toHaveAccessibleDescription(
      'Add an image from your files. You can also paste or drop one anywhere on this form.'
    );
    expect(screen.getByRole('button', { name: 'Capture app' })).toHaveAccessibleDescription(
      'Take a picture of this app. Never the rest of your screen.'
    );
    expect(screen.getByRole('button', { name: 'Point at it' })).toHaveAccessibleDescription(
      'Click the part that looks wrong. We’ll crop the picture to it.'
    );
  });

  it('gives each mounted toolbar its own input id', () => {
    // The Dev Playground mounts three feedback dialogs at once. With a module
    // constant for the id, every label points at the FIRST toolbar's input.
    render(
      <TooltipProvider>
        <ComposerToolbar
          showPictureTools
          isPreparing={false}
          hasPointed={false}
          hasWords={false}
          isMobile={false}
          onCapture={vi.fn()}
          onPointAtElement={vi.fn()}
          onPick={vi.fn()}
        />
        <ComposerToolbar
          showPictureTools
          isPreparing={false}
          hasPointed={false}
          hasWords={false}
          isMobile={false}
          onCapture={vi.fn()}
          onPointAtElement={vi.fn()}
          onPick={vi.fn()}
        />
      </TooltipProvider>
    );

    const inputs = screen.getAllByLabelText('Add an image');
    expect(inputs).toHaveLength(2);
    expect(inputs[0].id).not.toBe(inputs[1].id);
    const labels = document.querySelectorAll('label[for]');
    expect(Array.from(labels).map((l) => l.getAttribute('for'))).toEqual([
      inputs[0].id,
      inputs[1].id,
    ]);
  });

  it('hands the picked file straight to the host', () => {
    const { onPick } = renderToolbar();
    const file = new File(['x'], 'shot.png', { type: 'image/png' });

    fireEvent.change(screen.getByLabelText('Add an image'), { target: { files: [file] } });

    expect(onPick).toHaveBeenCalledWith(file);
  });

  it('clears the input after a pick, so the same file can be picked twice', () => {
    renderToolbar();
    const input = screen.getByLabelText<HTMLInputElement>('Add an image');
    // A jsdom file input reads `''` whether or not anything cleared it, so the
    // setter is watched directly: what CAN be observed is the clear happening.
    const setValue = vi.fn();
    Object.defineProperty(input, 'value', { get: () => '', set: setValue, configurable: true });

    fireEvent.change(input, {
      target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] },
    });

    expect(setValue).toHaveBeenCalledWith('');
  });

  it('holds the picker while an image is being prepared', () => {
    renderToolbar({ isPreparing: true });
    expect(screen.getByLabelText('Add an image')).toBeDisabled();
  });

  it('uses the photo wording on a narrow surface', () => {
    renderToolbar({ isMobile: true });
    expect(screen.getByLabelText('Add a photo')).toBeInTheDocument();
    expect(screen.queryByLabelText('Add an image')).not.toBeInTheDocument();
  });
});

describe('ComposerToolbar — capture and point', () => {
  it('offers one click that takes the picture', () => {
    const { onCapture } = renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Capture app' }));
    expect(onCapture).toHaveBeenCalledTimes(1);
  });

  it('offers the capture on touch too — a phone renders its own DOM as well as a laptop', () => {
    renderToolbar({ isMobile: true });
    expect(screen.getByRole('button', { name: 'Capture app' })).toBeInTheDocument();
  });

  it('offers "Point at it" as a live control on a wide surface', () => {
    const { onPointAtElement } = renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Point at it' }));
    expect(onPointAtElement).toHaveBeenCalledTimes(1);
  });

  it('hides "Point at it", which needs room and a pointer to aim with', () => {
    renderToolbar({ isMobile: true });
    expect(screen.queryByRole('button', { name: /point/i })).not.toBeInTheDocument();
  });

  it('says "Point again" once something has been pointed at', () => {
    renderToolbar({ hasPointed: true });
    expect(screen.getByRole('button', { name: 'Point again' })).toBeInTheDocument();
  });

  it('holds both while an image is still being prepared, without dropping focus', () => {
    const { onCapture, onPointAtElement } = renderToolbar({ isPreparing: true });
    const capture = screen.getByRole('button', { name: 'Capture app' });
    const point = screen.getByRole('button', { name: 'Point at it' });
    // `aria-disabled`, never `disabled`: a natively disabled button that holds
    // focus hands it to <body> mid-capture.
    expect(capture).toHaveAttribute('aria-disabled', 'true');
    expect(capture).not.toHaveAttribute('disabled');
    fireEvent.click(capture);
    fireEvent.click(point);
    expect(onCapture).not.toHaveBeenCalled();
    expect(onPointAtElement).not.toHaveBeenCalled();
  });
});

describe('ComposerToolbar — the send shortcut hint', () => {
  it('appears only once there are words', () => {
    renderToolbar({ hasWords: true });
    expect(screen.getByText(/to send$/)).toBeInTheDocument();
  });

  it('is left off a narrow surface, which has no keyboard shortcut to offer', () => {
    renderToolbar({ hasWords: true, isMobile: true });
    expect(screen.queryByText(/to send$/)).not.toBeInTheDocument();
  });
});

describe('ComposerToolbar — a surface that cannot send a picture', () => {
  it('offers none of the picture tools', () => {
    renderToolbar({ showPictureTools: false, hasWords: true });
    expect(screen.queryByRole('button', { name: 'Capture app' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Add an image')).not.toBeInTheDocument();
    expect(screen.getByText(/to send$/)).toBeInTheDocument();
  });

  it('renders nothing at all when there is nothing to show', () => {
    const { container } = render(
      <TooltipProvider>
        <ComposerToolbar
          showPictureTools={false}
          isPreparing={false}
          hasPointed={false}
          hasWords={false}
          isMobile={false}
          onCapture={vi.fn()}
          onPointAtElement={vi.fn()}
          onPick={vi.fn()}
        />
      </TooltipProvider>
    );
    expect(container).toBeEmptyDOMElement();
  });
});
