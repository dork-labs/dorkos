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

type FieldProps = Parameters<typeof ScreenshotField>[0];

afterEach(cleanup);

/** Render with a handle that re-renders the SAME element with changed props. */
function renderFieldWithRerender(overrides: Partial<FieldProps> = {}) {
  const base: FieldProps = {
    dataUrl: null,
    isPreparing: false,
    isDraggingOver: false,
    onPick: vi.fn(),
    onCapture: vi.fn(),
    onPointAtElement: vi.fn(),
    onRemove: vi.fn(),
    onPreview: vi.fn(),
    isMobile: false,
    ...overrides,
  };
  const view = render(<ScreenshotField {...base} />);
  return {
    ...base,
    rerender: (next: Partial<FieldProps>) => view.rerender(<ScreenshotField {...base} {...next} />),
  };
}

function renderField(overrides: Partial<FieldProps> = {}) {
  const props: FieldProps = {
    dataUrl: null,
    isPreparing: false,
    isDraggingOver: false,
    onPick: vi.fn(),
    onCapture: vi.fn(),
    onPointAtElement: vi.fn(),
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

  it('gives each mounted field its own input id', () => {
    // The Dev Playground mounts three feedback dialogs at once. With a module
    // constant for the id, every label points at the FIRST field's input, so
    // clicking the third box opens the first one's file picker.
    render(
      <>
        <ScreenshotField
          dataUrl={null}
          isPreparing={false}
          isDraggingOver={false}
          onPick={vi.fn()}
          onCapture={vi.fn()}
          onPointAtElement={vi.fn()}
          onRemove={vi.fn()}
          onPreview={vi.fn()}
          isMobile={false}
        />
        <ScreenshotField
          dataUrl={null}
          isPreparing={false}
          isDraggingOver={false}
          onPick={vi.fn()}
          onCapture={vi.fn()}
          onPointAtElement={vi.fn()}
          onRemove={vi.fn()}
          onPreview={vi.fn()}
          isMobile={false}
        />
      </>
    );

    const inputs = screen.getAllByLabelText('Add screenshot');
    expect(inputs).toHaveLength(2);
    expect(inputs[0].id).not.toBe(inputs[1].id);
    // And each label is wired to its OWN input, not to a shared one.
    const labels = document.querySelectorAll('label[for]');
    expect(Array.from(labels).map((l) => l.getAttribute('for'))).toEqual([
      inputs[0].id,
      inputs[1].id,
    ]);
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

  it('announces the empty-state label instead of only painting it', () => {
    // Drag and compression feedback are the two things a sighted user gets for
    // free here; a live region is how everyone else gets them.
    const { rerender } = renderFieldWithRerender();
    expect(screen.getByRole('status')).toHaveTextContent('Add screenshot');
    rerender({ isDraggingOver: true });
    expect(screen.getByRole('status')).toHaveTextContent('Drop to attach');
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

  it('offers the full preview from the thumbnail, named for what it opens', () => {
    // Three controls in the dialog said "View full preview"; this one opens the
    // screenshot, and a screen-reader list of three identical names is a guess.
    const { onPreview } = renderField({ dataUrl: SAMPLE });
    fireEvent.click(screen.getByRole('button', { name: 'View full screenshot' }));
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('says it is working while a REPLACEMENT image is being prepared', () => {
    // The attached branch used to have no in-flight cue at all, so replacing a
    // picture looked like nothing was happening until it swapped.
    renderField({ dataUrl: SAMPLE, isPreparing: true });
    expect(screen.getByText('Getting it ready…')).toBeInTheDocument();
    // And the image being replaced is still the one on screen until it lands.
    expect(screen.getByAltText('The screenshot you attached')).toHaveAttribute('src', SAMPLE);
  });

  it('announces the in-flight state rather than only showing it', () => {
    renderField({ dataUrl: SAMPLE, isPreparing: true });
    expect(screen.getByRole('status')).toHaveTextContent('Getting it ready…');
  });
});

describe('ScreenshotField — capture app view', () => {
  it('offers one click that takes the picture', () => {
    const { onCapture } = renderField();
    fireEvent.click(screen.getByRole('button', { name: /capture app view/i }));
    expect(onCapture).toHaveBeenCalledTimes(1);
  });

  it('says what the capture does and does not include', () => {
    // The one claim in this dialog that is about SCOPE rather than consent, and
    // the only capture whose output can honestly make it: both paths photograph
    // this page, never the screen around it.
    renderField();
    expect(
      screen.getByText('Captures only the app — never the rest of your screen.')
    ).toBeInTheDocument();
  });

  it('keeps the capture on offer with an image already attached, to replace it', () => {
    const { onCapture } = renderField({ dataUrl: SAMPLE });
    fireEvent.click(screen.getByRole('button', { name: /capture app view/i }));
    expect(onCapture).toHaveBeenCalledTimes(1);
  });

  it('offers it on touch too — a phone renders its own DOM as well as a laptop', () => {
    renderField({ isMobile: true });
    expect(screen.getByRole('button', { name: /capture app view/i })).toBeInTheDocument();
  });

  it('refuses a second capture while one is still being prepared', () => {
    // Not the safety mechanism — `captureAppView` refuses to run twice at once,
    // and the hook's generation counter decides which result may land — but a
    // button that stays live through a capture invites the double click that
    // makes people believe the first one did nothing.
    const { onCapture } = renderField({ isPreparing: true });
    const button = screen.getByRole('button', { name: /capture app view/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onCapture).not.toHaveBeenCalled();
  });
});

describe('ScreenshotField — touch surfaces', () => {
  it('offers the photo picker wording instead of the desktop wording', () => {
    renderField({ isMobile: true });
    expect(screen.getByLabelText('Add a photo')).toBeInTheDocument();
    // No hint at all: the label says the whole of it, and the desktop hint names
    // two ways in that a touch device does not have.
    expect(screen.queryByText('Drop one here, paste one, or browse your files.')).toBeNull();
  });

  it('makes no claim about the device being a phone', () => {
    // 768px is a breakpoint, not a phone — a narrow desktop window hits it too.
    renderField({ isMobile: true });
    expect(screen.queryByText(/phone/i)).not.toBeInTheDocument();
  });

  it('hides "Point at element", a pointer gesture that will never ship on touch', () => {
    renderField({ isMobile: true });
    expect(screen.queryByRole('button', { name: 'Point at element' })).not.toBeInTheDocument();
  });

  it('offers "Point at element" as a live control on a desktop', () => {
    // It was a labelled-soon placeholder until PR 4. A control that still LOOKS
    // like one — no button, nothing to press — is the failure this pins.
    const { onPointAtElement } = renderField({ isMobile: false });
    const point = screen.getByRole('button', { name: 'Point at element' });
    expect(point).toBeEnabled();
    fireEvent.click(point);
    expect(onPointAtElement).toHaveBeenCalledTimes(1);
  });

  it('holds "Point at element" back while an image is still being prepared', () => {
    // Aiming at a new element mid-compression would abandon the picture the
    // person is already waiting on, with nothing said about it.
    renderField({ isMobile: false, isPreparing: true });
    expect(screen.getByRole('button', { name: 'Point at element' })).toBeDisabled();
  });
});

describe('ScreenshotField — privacy microcopy', () => {
  it('says nothing is captured on its own, on both surfaces', () => {
    const line =
      'You choose what to attach and see it here before you send. Nothing is captured on its own.';
    renderField();
    expect(screen.getByText(line)).toBeInTheDocument();
    cleanup();
    renderField({ isMobile: true, dataUrl: SAMPLE });
    expect(screen.getByText(line)).toBeInTheDocument();
  });
});
