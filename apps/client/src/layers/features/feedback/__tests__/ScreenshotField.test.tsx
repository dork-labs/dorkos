// @vitest-environment jsdom
//
// jsdom limit worth naming: nothing here settles how the field LOOKS. The
// drag-over treatment, the thumbnail's fit inside its box and the focus ring on
// the label are all geometry or paint, which jsdom reports as 0x0 and cannot
// answer. What is asserted is which control exists, what it is called, and what
// it calls back with — the parts that are this component's own decisions.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ScreenshotField } from '../ui/ScreenshotField';

const SAMPLE = 'data:image/webp;base64,AAAA';

afterEach(cleanup);

function renderField(overrides: Partial<Parameters<typeof ScreenshotField>[0]> = {}) {
  const props = {
    dataUrl: null,
    isPreparing: false,
    isDraggingOver: false,
    onPick: vi.fn(),
    onRemove: vi.fn(),
    onPreview: vi.fn(),
    isMobile: false,
    ...overrides,
  };
  render(<ScreenshotField {...props} />);
  return props;
}

describe('ScreenshotField — empty state', () => {
  it('offers a labelled image-only file input a keyboard can reach', () => {
    renderField();
    const input = screen.getByLabelText('Add screenshot');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*');
    // `sr-only` hides it visually but leaves it in the tab order; `hidden` or
    // `display:none` would take the only keyboard route to the picker away.
    expect(input).not.toHaveAttribute('hidden');
  });

  it('names the three desktop ways in', () => {
    renderField();
    expect(screen.getByText('Drop one here, paste one, or browse your files.')).toBeInTheDocument();
  });

  it('hands the picked file straight to the host', () => {
    const { onPick } = renderField();
    const file = new File(['x'], 'shot.png', { type: 'image/png' });

    fireEvent.change(screen.getByLabelText('Add screenshot'), { target: { files: [file] } });

    expect(onPick).toHaveBeenCalledWith(file);
  });

  it('clears the input after a pick, so the same file can be picked twice', () => {
    renderField();
    const input = screen.getByLabelText<HTMLInputElement>('Add screenshot');
    // Asserting `input.value === ''` afterwards proves nothing — a jsdom file
    // input reads `''` whether or not anything cleared it. What CAN be observed
    // is the component performing the clear, so the setter is watched directly.
    // The browser behaviour this protects — a second pick of the SAME file
    // firing `change` again instead of being a silent no-op — is a real-browser
    // fact jsdom does not model, and is not claimed here.
    const setValue = vi.fn();
    Object.defineProperty(input, 'value', {
      get: () => '',
      set: setValue,
      configurable: true,
    });

    fireEvent.change(input, {
      target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] },
    });

    expect(setValue).toHaveBeenCalledWith('');
  });

  it('says "Drop to attach" while a drag is over the dialog', () => {
    renderField({ isDraggingOver: true });
    expect(screen.getByText('Drop to attach')).toBeInTheDocument();
    expect(screen.queryByText('Add screenshot')).not.toBeInTheDocument();
  });

  it('says it is working while the image is being compressed', () => {
    renderField({ isPreparing: true });
    expect(screen.getByText('Getting it ready…')).toBeInTheDocument();
  });
});

describe('ScreenshotField — attached state', () => {
  it('shows the exact image that will be sent', () => {
    renderField({ dataUrl: SAMPLE });
    expect(screen.getByAltText('The screenshot you attached')).toHaveAttribute('src', SAMPLE);
  });

  it('replaces the picker rather than sitting beside it (one image, not a list)', () => {
    renderField({ dataUrl: SAMPLE });
    expect(screen.queryByLabelText('Add screenshot')).not.toBeInTheDocument();
  });

  it('offers a remove control that drops the image', () => {
    const { onRemove } = renderField({ dataUrl: SAMPLE });
    fireEvent.click(screen.getByRole('button', { name: /remove screenshot/i }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('offers the full preview from the thumbnail', () => {
    const { onPreview } = renderField({ dataUrl: SAMPLE });
    fireEvent.click(screen.getByRole('button', { name: 'View full preview' }));
    expect(onPreview).toHaveBeenCalledTimes(1);
  });
});

describe('ScreenshotField — touch surfaces', () => {
  it('offers the photo picker wording instead of the desktop wording', () => {
    renderField({ isMobile: true });
    expect(screen.getByLabelText('Add a photo')).toBeInTheDocument();
    expect(screen.getByText('Pick a photo from your phone.')).toBeInTheDocument();
    expect(screen.queryByText('Drop one here, paste one, or browse your files.')).toBeNull();
  });

  it('hides "Point at element", a pointer gesture that will never ship on touch', () => {
    renderField({ isMobile: true });
    expect(screen.queryByText('Point at element (coming soon)')).not.toBeInTheDocument();
  });

  it('keeps "Point at element" on a desktop, where it is still the roadmap', () => {
    renderField({ isMobile: false });
    expect(screen.getByText('Point at element (coming soon)')).toBeInTheDocument();
  });
});

describe('ScreenshotField — privacy microcopy', () => {
  it('says nothing is captured on its own, on both surfaces', () => {
    const line =
      'You pick the image and see it here before you send. Nothing is captured on its own.';
    renderField();
    expect(screen.getByText(line)).toBeInTheDocument();
    cleanup();
    renderField({ isMobile: true, dataUrl: SAMPLE });
    expect(screen.getByText(line)).toBeInTheDocument();
  });
});
