// @vitest-environment jsdom
//
// jsdom limits worth naming, because they bound what this file can claim.
// Nothing here settles how the picker LOOKS: the highlight box is positioned
// from a `getBoundingClientRect()` jsdom reports as 0x0, the crosshair cursor
// and the scrim are paint, and there is no hit-testing at all — jsdom does not
// implement `elementFromPoint`, so it is stubbed. What IS this component's own
// decision, and is checked here: that it asks the document what is underneath
// rather than answering "the overlay", that it turns its own hit-testing off to
// do so and puts it straight back, which events mean select and which mean
// cancel, and what it says while each is happening.
//
// The half only a browser can answer — that the picker really covers the app,
// that nothing underneath reacts, that a click on a live button does not
// activate it — is in
// `apps/e2e/tests/dev-playground/feedback-point-at-element.spec.ts`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PointAtElementOverlay } from '../ui/PointAtElementOverlay';

type OverlayProps = Parameters<typeof PointAtElementOverlay>[0];

beforeEach(() => {
  // jsdom implements no hit-testing at all, so `document.elementFromPoint` is
  // not merely wrong here — it does not exist, and a spy cannot replace a
  // property that is absent. Installed as a real one first, then stubbed per
  // test; a browser has this and every other DOM in the app relies on it.
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    writable: true,
    value: () => null,
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** The app underneath the picker, and the picker over it. */
function renderOverlay(overrides: Partial<OverlayProps> = {}) {
  const app = document.createElement('div');
  app.id = 'root';
  app.innerHTML = '<button data-slot="sidebar-toggle" data-testid="nav-toggle">Toggle</button>';
  document.body.append(app);
  const target = app.querySelector('button');
  if (!target) throw new Error('the app under the picker must have something to point at');

  const props: OverlayProps = {
    phase: 'picking',
    onSelect: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<PointAtElementOverlay {...props} />);
  const overlay = screen.getByRole('dialog');
  return { ...props, overlay, target };
}

/** Stand in for the browser's hit-testing, which jsdom does not have. */
function stubElementFromPoint(answer: Element | null): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(document, 'elementFromPoint').mockReturnValue(answer as Element);
}

describe('PointAtElementOverlay — what it says', () => {
  it('tells the person what to do and how to get out', () => {
    renderOverlay();

    expect(screen.getByText('Click the part that looks wrong. Esc to cancel.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('says the picture is being taken once the aiming is over', () => {
    renderOverlay({ phase: 'capturing' });

    expect(screen.getByText('Taking the picture…')).toBeInTheDocument();
    // Nothing to cancel any more: the capture is already running, and a control
    // that cannot stop what it names is a lie.
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('names itself for anyone who cannot see the crosshair', () => {
    renderOverlay();

    expect(screen.getByRole('dialog')).toHaveAccessibleName(
      'Point at the part of the app that looks wrong'
    );
  });
});

describe('PointAtElementOverlay — finding what is underneath', () => {
  it('turns its own hit-testing off for the lookup, and straight back on', () => {
    // Without this the browser answers "the overlay" for every point, and the
    // picker highlights itself. Restoring it matters just as much: an overlay
    // left transparent to the pointer stops swallowing clicks, and the next one
    // lands on the live app.
    const { overlay, target } = renderOverlay();
    let hitTestingDuringLookup: string | null = null;
    vi.spyOn(document, 'elementFromPoint').mockImplementation(() => {
      hitTestingDuringLookup = overlay.style.pointerEvents;
      return target;
    });

    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });

    expect(hitTestingDuringLookup).toBe('none');
    expect(overlay.style.pointerEvents).not.toBe('none');
  });

  it('shows the name of the thing under the pointer', () => {
    const { overlay, target } = renderOverlay();
    stubElementFromPoint(target);

    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });

    // The test id first — it is the name the codebase itself uses for this part.
    expect(screen.getByText('nav-toggle')).toBeInTheDocument();
  });

  it('falls back to the slot, and then the tag, for an element with no test id', () => {
    const { overlay } = renderOverlay();
    const app = document.getElementById('root');
    if (!app) throw new Error('the app root must exist');
    const slotted = document.createElement('div');
    slotted.dataset.slot = 'composer';
    app.append(slotted);
    stubElementFromPoint(slotted);
    fireEvent.pointerMove(overlay, { clientX: 10, clientY: 10 });
    expect(screen.getByText('composer')).toBeInTheDocument();

    const anonymous = document.createElement('section');
    app.append(anonymous);
    stubElementFromPoint(anonymous);
    fireEvent.pointerMove(overlay, { clientX: 20, clientY: 20 });
    expect(screen.getByText('section')).toBeInTheDocument();
  });

  it('highlights nothing while the pointer is over its own controls', () => {
    // The bar sits over the app like everything else. Lighting up whatever
    // happens to be behind the Cancel button would be pointing at a lie.
    const { overlay, target } = renderOverlay();
    stubElementFromPoint(target);
    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });
    expect(screen.getByText('nav-toggle')).toBeInTheDocument();

    fireEvent.pointerMove(screen.getByRole('button', { name: 'Cancel' }), {
      clientX: 500,
      clientY: 900,
    });

    expect(screen.queryByText('nav-toggle')).not.toBeInTheDocument();
  });

  it('stops aiming once the pointer has left the window', () => {
    const { overlay, target } = renderOverlay();
    stubElementFromPoint(target);
    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });

    fireEvent.pointerLeave(overlay);

    expect(screen.queryByText('nav-toggle')).not.toBeInTheDocument();
  });

  it('does not aim at all once the picture is being taken', () => {
    const { overlay, target } = renderOverlay({ phase: 'capturing' });
    stubElementFromPoint(target);

    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });

    expect(screen.queryByText('nav-toggle')).not.toBeInTheDocument();
  });
});

describe('PointAtElementOverlay — committing', () => {
  it('hands back the element that was under the click', () => {
    const { overlay, target, onSelect } = renderOverlay();
    stubElementFromPoint(target);

    fireEvent.click(overlay, { clientX: 40, clientY: 40 });

    expect(onSelect).toHaveBeenCalledWith(target);
  });

  it('resolves the click fresh rather than trusting the last thing hovered', () => {
    // A click can arrive with no move before it, and a move can be stale by the
    // time the press lands. The point that was CLICKED is the one that counts.
    const { overlay, target, onSelect } = renderOverlay();
    const other = document.createElement('span');
    document.getElementById('root')?.append(other);
    stubElementFromPoint(other);
    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 40 });
    stubElementFromPoint(target);

    fireEvent.click(overlay, { clientX: 900, clientY: 900 });

    expect(onSelect).toHaveBeenCalledWith(target);
  });

  it('takes no pick from a click on its own Cancel bar', () => {
    const { onSelect, onCancel, target } = renderOverlay();
    stubElementFromPoint(target);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('ignores a click once the picture is already being taken', () => {
    const { overlay, target, onSelect } = renderOverlay({ phase: 'capturing' });
    stubElementFromPoint(target);

    fireEvent.click(overlay, { clientX: 40, clientY: 40 });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('says nothing when the browser finds nothing under the pointer', () => {
    const { overlay, onSelect } = renderOverlay();
    stubElementFromPoint(null);

    fireEvent.click(overlay, { clientX: 40, clientY: 40 });

    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('PointAtElementOverlay — getting out', () => {
  it('cancels on Escape, from anywhere on the page', () => {
    const { onCancel } = renderOverlay();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on a right-click, the other reflex for “not this”', () => {
    const { overlay, onCancel, onSelect } = renderOverlay();

    fireEvent.contextMenu(overlay, { clientX: 40, clientY: 40 });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('leaves other keys to the app', () => {
    const { onCancel } = renderOverlay();

    fireEvent.keyDown(document.body, { key: 'a' });
    fireEvent.keyDown(document.body, { key: 'Enter' });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('stops listening for Escape once it is gone', () => {
    // A key handler outliving its overlay would cancel a picker that is not
    // there, on a press meant for whatever has focus now.
    const { onCancel } = renderOverlay();
    cleanup();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onCancel).not.toHaveBeenCalled();
  });
});
